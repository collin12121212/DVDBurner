'use strict';

/**
 * The pipeline: inspect, prepare, build, burn.
 *
 * This is the only module that knows the order of operations, and it is
 * deliberately written as a sequence of small, resumable stages rather than one
 * long function. When something fails, the caller knows exactly which stage
 * failed and the work already done — expensive encoding especially — is not
 * thrown away.
 *
 * The stage order exists because each one needs the previous one's output:
 *
 *   inspect  ffprobe every source, decide the disc format and bitrate budget
 *   encode   ffmpeg -> spec-legal MPEG-2 program streams
 *   menu     render the designed menu to a still, multiplex the buttons in
 *   author   dvdauthor -> a real VIDEO_TS tree
 *   image    a UDF disc image ready to burn or hand to another machine
 *   burn     hdiutil -> an actual disc in an actual drive
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const spec = require('./dvd_spec');
const probeMod = require('./probe');
const encode = require('./encode');
const author = require('./author');
const deckModel = require('./deck');
const slideLayout = require('./slide_layout');
const deckRender = require('./deck_render');
const dvdModel = require('./dvd_model');
const disc = require('./disc');

/**
 * Everything a job needs, resolved once. `project` is the shape the UI edits;
 * `plan` is the shape the pipeline executes.
 */
function normaliseProject(input = {}) {
  const videos = (Array.isArray(input.videos) ? input.videos : []).map((v, i) => ({
    id: v.id || `video-${i + 1}`,
    path: v.path,
    name: v.name || path.basename(String(v.path || `video-${i + 1}`)),
    menuLabel: v.menuLabel || '',
    duration: Number(v.duration) || 0,
    probe: v.probe || null,
    // Populated by the encode stage.
    parts: v.parts || null,
    chapters: v.chapters || null,
    encodeError: null,
    bytes: v.bytes || 0,
  }));

  const discTitle = String(input.discTitle || 'My DVD').slice(0, 60);
  const deck = deckModel.normaliseDeck(
    input.deck && Array.isArray(input.deck.slides) && input.deck.slides.length
      ? { ...input.deck, discTitle: input.deck.discTitle || discTitle }
      : defaultDeck(discTitle, videos, input)
  );

  return {
    discTitle,
    // The video system is never chosen by the person using the app: she is in
    // North America, so it is NTSC, and the wrong answer here is the single
    // most common reason a burned DVD will not play.
    videoFormat: 'ntsc',
    titleAspect: String(input.titleAspect || '').toLowerCase() === '4:3' ? '4:3' : '16:9',
    audioMode: input.audioMode === 'surround' ? 'surround' : 'stereo',
    discType: input.discType === 'dvd9' ? 'dvd9' : 'dvd5',
    chaptersEnabled: input.chaptersEnabled !== false,
    chapterMinutes: clamp(Number(input.chapterMinutes) || 5, 1, 30),
    deck,
    videos,
    output: {
      workDir: input.output && input.output.workDir ? input.output.workDir : null,
      buildIso: !input.output || input.output.buildIso !== false,
      keepFolder: Boolean(input.output && input.output.keepFolder),
    },
  };
}

/**
 * The deck to use when nothing has been designed yet.
 *
 * A project always begins with a menu slide. A menu is where a player's menu
 * button goes, where playback returns to when a video ends, and the only way to
 * choose between episodes — a disc that skips straight into a video is a disc
 * someone has to sit through.
 *
 * The menu slide starts with no buttons on purpose. Its buttons are generated
 * from the video list and kept in step by the editor, so a video added later
 * appears on the menu without anyone having to remember to add it.
 */
function defaultDeck(discTitle, videos, input) {
  const themeId = (input && input.themeId) || 'charcoal';
  const slides = [deckModel.episodeListSlide([], { title: discTitle, themeId })];
  return { discTitle, themeId, buttonStyle: 'bar', slides };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Stage one: read every source file and work out whether this disc is possible.
 *
 * No encoding happens here, so the user gets an answer in seconds and can fix
 * an oversized disc before waiting an hour.
 */
async function inspect(project, { tools, onProgress } = {}) {
  if (!tools || !tools.ffprobe) {
    throw new Error('The video inspection tool is missing, so files cannot be read.');
  }
  if (!project.videos.length) {
    throw new Error('Add at least one video first.');
  }

  const videos = [];
  const errors = [];

  for (let i = 0; i < project.videos.length; i += 1) {
    const video = project.videos[i];
    if (onProgress) {
      onProgress({
        stage: 'inspect',
        index: i,
        total: project.videos.length,
        message: `Reading ${video.name}\u2026`,
      });
    }
    try {
      const info = await probeMod.probeVideo(tools.ffprobe, video.path);
      videos.push({ ...video, probe: info, duration: info.duration, bytes: info.sizeBytes });
    } catch (err) {
      errors.push({ video, error: String(err.message || err) });
    }
  }

  const totalSeconds = videos.reduce((sum, v) => sum + (v.duration || 0), 0);
  const plan = spec.planBitrate({
    totalSeconds,
    formatId: project.videoFormat,
    audioMode: project.audioMode,
    discType: project.discType,
  });

  return {
    videos,
    errors,
    totalSeconds,
    plan,
    usable: videos.length > 0,
  };
}

/**
 * Stage two: encode, design, author.
 *
 * Returns a `prepared` object that later stages consume. Encoding results are
 * cached on the project, so pressing Build twice does not re-encode.
 */
async function prepare(project, { tools, workDir, onProgress, onLog, signal, BrowserWindow }) {
  requireTools(tools, ['ffmpeg', 'ffprobe']);
  if (!tools.dvdauthor) {
    throw new Error(
      'The disc-building tool (dvdauthor) is not installed, so a playable DVD ' +
        'cannot be built. Open Setup for install instructions.'
    );
  }

  const root = workDir || project.output.workDir;
  if (!root) throw new Error('No working folder has been set.');
  fs.mkdirSync(root, { recursive: true });

  // Work out the plan fresh, so a changed file list is reflected immediately.
  const inspection = await inspect(project, { tools, onProgress });
  if (!inspection.usable) {
    const first = inspection.errors[0];
    throw new Error(
      first
        ? `None of the videos could be read. ${first.error}`
        : 'None of the videos could be read.'
    );
  }

  const plan = inspection.plan;
  const videos = inspection.videos;
  const totalSeconds = inspection.totalSeconds;

  // Weights let one long film account for more of the progress bar than a short
  // clip, so the bar moves at a believable pace.
  const weights = videos.map((v) => Math.max(1, v.duration || 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let doneWeight = 0;

  // ---- encode each title -------------------------------------------------
  const encoded = [];
  for (let i = 0; i < videos.length; i += 1) {
    if (signal && signal.aborted) throw new encode.AbortError('Stopped.');

    const video = videos[i];
    const titleDir = path.join(root, 'titles', `title_${i + 1}`);
    encode.resetOutputDir(titleDir);

    const outputVob = path.join(titleDir, 'VTS_01_1.VOB');
    const weight = weights[i];
    const baseWeight = doneWeight;

    // A source with no audio still needs a silent track, or some players will
    // refuse to navigate past the title.
    const needsSilence = !video.probe || !video.probe.hasAudio;

    const displayName = video.menuLabel || video.name;

    try {
      const result = await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: video.path,
        outputVob,
        plan: {
          ...plan,
          hasAudio: !needsSilence,
          // The encoder needs the probe for per-source decisions: the colour
          // matrix (BT.709 HD vs BT.601 SD) and nothing else it can't derive.
          probe: video.probe || null,
        },
        durationSeconds: video.duration,
        aspect: { ratio: project.titleAspect === '4:3' ? '4:3' : '16:9' },
        onProgress: (fraction) => {
          if (!onProgress) return;
          const overall = totalWeight > 0 ? (baseWeight + fraction * weight) / totalWeight : 0;
          onProgress({
            stage: 'encode',
            fraction: Math.min(1, overall),
            message: `Preparing ${i + 1} of ${videos.length}: ${displayName}`,
          });
        },
        signal,
      });

      const parts = result.parts.map((file) => ({ file, bytes: safeSize(file) }));

      if (needsSilence) {
        // Replace the absent audio with silence by re-muxing. ffmpeg cannot add
        // an audio stream to an already-muxed DVD stream, so the title is
        // encoded once more with a generated silent input. This is rare enough
        // that the extra pass is not worth optimising away.
        await addSilenceTrack({
          ffmpegPath: tools.ffmpeg,
          parts,
          titleDir,
          plan,
          duration: video.duration,
          aspect: { ratio: project.titleAspect === '4:3' ? '4:3' : '16:9' },
          signal,
        });
      }

      const partsAfter = encode.listTitleParts(titleDir).map((file) => ({ file, bytes: safeSize(file) }));

      encoded.push({
        ...video,
        parts: partsAfter,
        chapters: project.chaptersEnabled
          ? author.distributeChapters(partsAfter, video.duration, {
              intervalSeconds: project.chapterMinutes * 60,
            })
          : partsAfter.map(() => []),
      });
    } catch (err) {
      if (err && err.isAbort) throw err;
      // One bad file should not destroy the whole disc: the others are still
      // worth burning, and the error is reported per video.
      encoded.push({ ...video, parts: null, chapters: null, encodeError: String(err.message || err) });
    }

    doneWeight += weight;
  }

  const good = encoded.filter((v) => v.parts && v.parts.length);
  if (!good.length) {
    const reason = encoded.find((v) => v.encodeError);
    throw new Error(
      `Nothing could be prepared. ${reason ? reason.encodeError : 'All videos failed.'}`
    );
  }

  // ---- menu pages from the slide deck ------------------------------------
  if (onProgress) {
    onProgress({ stage: 'menu', fraction: 0, message: 'Drawing your slides\u2026' });
  }
  const built = await buildMenus({
    project,
    videos: good,
    tools,
    root,
    BrowserWindow,
    signal,
  });

  // ---- author ------------------------------------------------------------
  if (onProgress) {
    onProgress({ stage: 'author', fraction: 0, message: 'Building the disc structure\u2026' });
  }

  const xml = author.buildDvdauthorXml({
    videoFormat: project.videoFormat,
    titleAspect: project.titleAspect,
    menus: built.menus,
    // Each title carries where it goes when it finishes, taken from the same
    // model the simulator reads, so the preview and the disc agree about what
    // plays next. Titles are numbered from one, in the order they were prepared.
    titles: good.map((video, index) => ({
      parts: video.parts,
      chapters: video.chapters,
      nextTitle: built.model ? built.model.nextTitleByNumber[index + 1] : null,
    })),
  });

  const authorDir = path.join(root, 'author');
  fs.mkdirSync(authorDir, { recursive: true });
  // dvdauthor refuses to write into a folder holding another VIDEO_TS, so clear
  // the destination's disc structure (and only that) before each run.
  removeDiscStructure(authorDir);

  const authored = await author.runDvdauthor({
    dvdauthorPath: tools.dvdauthor,
    xml,
    workDir: authorDir,
    videoFormat: project.videoFormat,
    onOutput: onLog,
    signal,
  });

  const prepared = {
    plan,
    videos: good,
    failed: encoded.filter((v) => v.encodeError),
    menus: built.menus,
    slideProblems: built.layout.problems,
    videoTsDir: authored.videoTsDir,
    volumeLabel: author.discLabel(project.discTitle),
    totalSeconds: good.reduce((sum, v) => sum + (v.duration || 0), 0),
    builtAt: new Date().toISOString(),
  };

  /*
    Record what was built, so the next run can tell whether it is still current.

    This is what makes the prepared disc reusable across an app upgrade. The
    folder it sits in belongs to the user, not the app, and the fingerprint
    describes the project exactly — so opening the app, changing nothing and
    pressing Burn should not re-encode anything, while changing anything at all
    should be noticed rather than silently burning the old disc.
  */
  prepared.fingerprint = projectFingerprint(project);
  try {
    fs.writeFileSync(
      path.join(root, 'build.json'),
      JSON.stringify(
        {
          fingerprint: prepared.fingerprint,
          builtAt: prepared.builtAt,
          volumeLabel: prepared.volumeLabel,
          videoCount: good.length,
          slideCount: built.layout.slides.length,
          totalSeconds: prepared.totalSeconds,
          app: appVersion(),
        },
        null,
        2
      )
    );
  } catch {
    // A build that cannot be recorded is still a build. It just cannot be reused.
  }

  if (onProgress) {
    onProgress({ stage: 'author', fraction: 1, message: 'Disc structure ready.' });
  }

  return prepared;
}

/** This app's version, for the build record. */
function appVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return 'unknown';
  }
}

/**
 * A fingerprint of everything that decides what ends up on the disc.
 *
 * The slides, the films on them, the order, the disc settings — and for each
 * video its size and modification time, so replacing a file in place with a
 * different one is noticed even if the path is the same.
 *
 * Deliberately NOT included: app version, tool paths, the work folder. None of
 * those change the disc, and including them would force a rebuild after every
 * bug fix — which is the thing this exists to avoid.
 */
function projectFingerprint(project) {
  const videos = (project.videos || []).map((video) => {
    let size = 0;
    let mtime = 0;
    try {
      const stat = fs.statSync(video.path);
      size = stat.size;
      mtime = Math.round(stat.mtimeMs);
    } catch {
      // A missing file still has to fingerprint, or removing one would look
      // like no change at all.
    }
    return {
      path: video.path,
      size,
      mtime,
      duration: video.duration || null,
      name: video.name || null,
      menuLabel: video.menuLabel || null,
    };
  });

  const canonical = JSON.stringify({
    // The disc title is the volume label on the finished disc, so changing it
    // changes the disc.
    discTitle: project.discTitle || null,
    deck: project.deck,
    videos,
    videoFormat: project.videoFormat,
    aspect: project.aspect,
    audioMode: project.audioMode,
    chaptersEnabled: project.chaptersEnabled,
    chapterMinutes: project.chapterMinutes,
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Read the record of what was last built into this folder.
 *
 * Returns null when nothing has been built there, so a first run is not
 * mistaken for a stale one.
 */
function readBuildRecord(workDir) {
  try {
    const raw = fs.readFileSync(path.join(workDir, 'build.json'), 'utf8');
    const record = JSON.parse(raw);
    return record && record.fingerprint ? record : null;
  } catch {
    return null;
  }
}

/**
 * Build every menu page from the slide deck.
 *
 * Each slide becomes one DVD menu page: the picture is rendered, encoded as a
 * legal one-frame MPEG-2 stream, and then given its button subpictures by
 * spumux. Button commands are resolved here, because this is the only place
 * that knows both the title numbering (position in the prepared video list) and
 * the menu numbering (position among the slides that actually have buttons).
 */
async function buildMenus({ project, videos, tools, root, BrowserWindow, signal }) {
  // The whole navigation graph — pages, buttons, rectangles, arrow-key
  // movement and jump commands — comes from one place, so the disc that gets
  // burned and the simulator that previews it are derived from the same data.
  const model = dvdModel.buildDiscModel({
    deck: project.deck || {},
    videos,
    aspect: project.titleAspect || '16:9',
  });
  const { deck, layout } = model;

  // Only slides that carry at least one button become a menu page: a DVD menu
  // with nothing to choose is a dead end for whoever is holding the remote.
  if (!model.menus.length) {
    return { menus: [], layout, deck, model };
  }

  if (signal && signal.aborted) throw new encode.AbortError('Stopped.');

  const menuDir = path.join(root, 'menu');
  const pngDir = path.join(menuDir, 'slides');
  fs.mkdirSync(menuDir, { recursive: true });

  const rendered = await deckRender.renderDeck({
    layout,
    outputDir: pngDir,
    BrowserWindow,
  });
  const pngBySlideId = new Map(rendered.files.map((f) => [f.slideId, f.path]));

  const highlightColor = deck.highlightColor || '#e0a34a';
  const selectColor = deck.selectColor || '#f2c477';

  const menus = [];

  for (const page of model.menus) {
    const pngPath = pngBySlideId.get(page.slideId);
    if (!pngPath) {
      throw new Error(`The picture for "${page.title}" was not produced.`);
    }

    const stillPath = path.join(menuDir, `menu_still_${page.slideIndex + 1}.mpg`);
    await runFfmpeg(
      tools.ffmpeg,
      author.buildMenuStillArgs({
        inputPng: pngPath,
        outputVob: stillPath,
        videoFormat: project.videoFormat,
        aspect: project.titleAspect || '16:9',
      })
    );

    /*
      The layer the player puts over the menu to show which button is lit.

      spumux takes these as image files, so they are pictures of the button
      rectangles: transparent everywhere else. Both are referenced by bare
      filename, which resolves because spumux is run with the menu folder as its
      working directory.
    */
    const boxes = page.buttons.map((button) => ({
      x0: button.x0,
      y0: button.y0,
      x1: button.x1,
      y1: button.y1,
    }));

    const highlightName = `highlight_${page.page}.png`;
    const selectName = `select_${page.page}.png`;

    const highlightArgs = author.buildHighlightImageArgs({
      outputPng: path.join(menuDir, highlightName),
      boxes,
      color: highlightColor,
      // Lit, but see-through enough to read the label underneath.
      opacity: 84,
    });
    const selectArgs = author.buildHighlightImageArgs({
      outputPng: path.join(menuDir, selectName),
      boxes,
      color: selectColor,
      // The button just pressed, so brighter.
      opacity: 210,
    });

    if (highlightArgs) await runFfmpeg(tools.ffmpeg, highlightArgs);
    if (selectArgs) await runFfmpeg(tools.ffmpeg, selectArgs);

    const buttonedPath = path.join(menuDir, `menu_buttoned_${page.slideIndex + 1}.mpg`);
    await runSpumuxToFile({
      spumuxPath: tools.spumux,
      xml: author.buildSpumuxXml({
        buttons: page.buttons,
        navigation: page.navigation,
        highlightPath: highlightArgs ? highlightName : null,
        selectPath: selectArgs ? selectName : null,
        videoFormat: project.videoFormat,
      }),
      inputVob: stillPath,
      outputPath: buttonedPath,
      workDir: menuDir,
      signal,
    });

    menus.push({
      slideId: page.slideId,
      title: page.title,
      pngPath,
      vobPath: buttonedPath,
      buttons: page.buttons,
    });
  }

  if (!menus.length) {
    throw new Error(
      'None of the slides had a button that could be used, so there would be no ' +
        'way to choose anything on the disc. Add a button, or turn the menu off.'
    );
  }

  return { menus, layout, deck, model };
}

/**
 * spumux writes to stdout, which we redirect into the target file. Running it
 * as a shell redirect would mean a shell and a quoting problem, so the output
 * stream is piped by hand instead.
 */
function runSpumuxToFile({ spumuxPath, xml, inputVob, outputPath, workDir, signal }) {
  return new Promise((resolve, reject) => {
    if (!spumuxPath) {
      return reject(
        new Error(
          'The menu tool (spumux) is not installed, so a menu cannot be built. ' +
            'Turn the menu off, or open Setup for install instructions.'
        )
      );
    }

    const xmlPath = path.join(workDir, 'menu_buttons.xml');
    fs.writeFileSync(xmlPath, xml, 'utf8');
    fs.rmSync(outputPath, { force: true });

    const out = fs.createWriteStream(outputPath);
    /*
      spumux takes exactly one argument — the control file — and reads the video
      to attach subtitles to from its standard input, writing the result to
      standard output:

        spumux [options] script.sub < in.mpg > out.mpg

      Passing the VOB as a second argument is rejected outright with "Only one
      argument expected", so the VOB is piped in instead.
    */
    const child = spawn(spumuxPath, [xmlPath], { windowsHide: true, cwd: workDir });
    const input = fs.createReadStream(inputVob);
    input.on('error', (err) => {
      out.destroy();
      reject(new Error(`Could not read the menu video: ${err.message}`));
    });
    input.pipe(child.stdin);

    const logs = [];
    child.stdout.pipe(out);
    child.stderr.on('data', (c) => logs.push(c));

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      out.destroy();
      reject(new Error(`Could not start the menu tool: ${err.message}`));
    });

    out.on('error', (err) => {
      reject(new Error(`Could not write the menu video: ${err.message}`));
    });

    child.on('close', (code) => {
      out.end(() => {
        if (signal && signal.aborted) return reject(new encode.AbortError('Stopped.'));
        const log = Buffer.concat(logs).toString();
        if (code !== 0) {
          const line = log.split('\n').map((l) => l.trim()).filter(Boolean).pop();
          return reject(new Error(`Building the menu failed. ${line || 'No reason given.'}`));
        }
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          return reject(new Error('Building the menu produced an empty file.'));
        }
        resolve(outputPath);
      });
    });
  });
}

/** Run ffmpeg to completion for a one-shot filter job. */
function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => {
      err = (err + c.toString()).slice(-4000);
    });
    child.on('error', (e) => reject(new Error(`Could not start the video tool: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const line = err.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        reject(new Error(`Preparing the menu picture failed. ${line || 'No reason given.'}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Re-encode a title with a generated silent AC-3 track.
 *
 * Some camcorders and screen recordings produce files with no audio stream at
 * all. A DVD title with no audio is technically legal but is refused by some
 * players, so silence is added rather than leaving a landmine.
 */
async function addSilenceTrack({ ffmpegPath, parts, titleDir, plan, duration, aspect, signal }) {
  const silentWav = path.join(titleDir, 'silence.ac3');
  await runFfmpeg(
    ffmpegPath,
    encode.buildSilentAudioArgs({
      output: silentWav,
      seconds: duration,
      audioBitrate: plan.audioBitrate,
      channels: plan.audio.channels,
    })
  );

  // Re-encode video plus the silent track together. Muxing a new stream into an
  // existing DVD program stream is not supported, so the picture is encoded
  // again; this path is rare enough not to be worth optimising.
  for (const part of parts) {
    if (signal && signal.aborted) throw new encode.AbortError('Stopped.');
    const temp = `${part.file}.withaudio.mpg`;
    await runFfmpeg(ffmpegPath, [
      '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
      '-i', part.file,
      '-i', silentWav,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'dvd',
      temp,
    ]);
    fs.rmSync(part.file, { force: true });
    fs.renameSync(temp, part.file);
  }

  fs.rmSync(silentWav, { force: true });
}

/** Build a disc image from a prepared project. */
async function makeImage(prepared, { tools, outputIso, onProgress, signal, verify = false }) {
  const iso = outputIso || path.join(path.dirname(prepared.videoTsDir), `${prepared.volumeLabel}.iso`);

  return disc.buildIso({
    // The image must contain the VIDEO_TS folder at its root, so the source is
    // the *parent* of VIDEO_TS.
    sourceDir: path.dirname(prepared.videoTsDir),
    outputIso: iso,
    volumeLabel: prepared.volumeLabel,
    hdiutil: tools.hdiutil,
    mkisofs: tools.mkisofs,
    onProgress,
    signal,
  });
}

/** Burn a prepared project to a real disc. */
async function burn(prepared, { tools, device, onProgress, signal, verify = true, workDir, log }) {
  const isoPath = path.join(workDir || path.dirname(prepared.videoTsDir), `${prepared.volumeLabel}.iso`);

  /*
    The image is always built here, never reused.

    This used to skip the build when a file of that name already existed — and
    the name comes from the disc's label, so it is the same file every time for a
    given project. The result was that the second burn of a project wrote the
    first burn's image, with no sign anything was wrong until the disc came out
    of the player. That is how a fixed bug still burns a broken disc.

    Rebuilding costs seconds. A disc costs a disc, and cannot be reused.
  */
  if (log) log('Building the disc image\u2026');
  await makeImage(prepared, {
    tools,
    outputIso: isoPath,
    onProgress: (f) =>
      onProgress && onProgress({ stage: 'image', fraction: f, message: 'Building the disc image\u2026' }),
    signal,
  });

  if (onProgress) {
    onProgress({ stage: 'burn', fraction: 0, message: 'Writing to disc. Do not remove it\u2026' });
  }

  const result = await disc.burnIso({
    isoPath,
    device,
    hdiutil: tools.hdiutil,
    onProgress: (f) =>
      onProgress && onProgress({ stage: 'burn', fraction: f, message: 'Writing to disc. Do not remove it\u2026' }),
    signal,
    verify,
  });

  return { ...result, isoPath };
}

/** Copy the finished VIDEO_TS folder somewhere the user chose. */
function saveFolder(prepared, destination, onProgress) {
  return disc.copyDiscFolder({
    videoTsDir: prepared.videoTsDir,
    destination,
    onProgress,
  });
}

/**
 * Remove only the files that make up a disc structure, leaving anything else in
 * the folder alone. This mirrors what dvdauthor's own `-O` does, and it is why
 * a crashed run cannot leave a stale VIDEO_TS behind to confuse the next one.
 */
function removeDiscStructure(dir) {
  const videoTs = path.join(dir, 'VIDEO_TS');
  const audioTs = path.join(dir, 'AUDIO_TS');
  for (const target of [videoTs, audioTs]) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const entry of safeReaddir(dir)) {
    if (/\.(iso|img|log)$/i.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function requireTools(tools, names) {
  const missing = names.filter((n) => !tools[n]);
  if (missing.length) {
    throw new Error(
      `These required tools are missing: ${missing.join(', ')}. Open Setup for how to install them.`
    );
  }
}

/**
 * A quick sanity check of a finished disc, run after authoring.
 *
 * This is cheap insurance: it reads the *actual* encoded files back with
 * ffprobe and confirms the resolution, frame rate and audio format match the
 * format that was asked for. Catching a spec violation here costs seconds;
 * catching it after a burn costs a blank disc and twenty minutes.
 */
async function verifyDisc(prepared, { tools }) {
  const problems = [];
  const isPal = prepared.plan.format.id === 'pal';
  const expected = {
    width: 720,
    height: isPal ? 576 : 480,
    fps: isPal ? 25 : 30000 / 1001,
  };

  for (const video of prepared.videos) {
    for (const part of video.parts || []) {
      try {
        const info = await probeMod.probeVideo(tools.ffprobe, part.file);
        if (info.width !== expected.width) {
          problems.push(`${video.name}: width is ${info.width}, expected ${expected.width}.`);
        }
        if (info.height !== expected.height) {
          problems.push(`${video.name}: height is ${info.height}, expected ${expected.height}.`);
        }
        if (Math.abs(info.fps - expected.fps) > 0.05) {
          problems.push(
            `${video.name}: frame rate is ${info.fps}, expected ${expected.fps.toFixed(3)}.`
          );
        }
        if (info.audioCodec && info.audioCodec !== 'ac3') {
          problems.push(`${video.name}: sound is ${info.audioCodec}, expected ac3.`);
        }
        if (info.audioSampleRate && Number(info.audioSampleRate) !== 48000) {
          problems.push(
            `${video.name}: sound is ${info.audioSampleRate} Hz, expected 48000 Hz.`
          );
        }
      } catch (err) {
        problems.push(`${video.name}: could not be read back (${err.message}).`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  normaliseProject,
  defaultDeck,
  inspect,
  prepare,
  makeImage,
  burn,
  saveFolder,
  verifyDisc,
  removeDiscStructure,
  buildMenus,
  // For deciding whether what is on disk is still what the project says.
  projectFingerprint,
  readBuildRecord,
};
