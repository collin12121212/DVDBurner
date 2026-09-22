'use strict';

/**
 * Burnhouse main process.
 *
 * The renderer runs with context isolation on and no Node access, and talks to
 * the pipeline only through the narrow, explicit channel list in preload.js.
 * That matters because this app handles arbitrary files chosen by the user: the
 * window should never be able to name a path the pipeline will act on without
 * the main process having agreed to it.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

const settingsStore = require('./settings');
const { JobRunner } = require('./jobs');
const { detectTools, toolVersion } = require('../core/tools');
const pipeline = require('../core/pipeline');
const disc = require('../core/disc');
const deckModel = require('../core/deck');
const slideLayout = require('../core/slide_layout');
const dvdModel = require('../core/dvd_model');
const deckRender = require('../core/deck_render');
const probeMod = require('../core/probe');
const { startServer } = require('../server/serve');

const jobs = new JobRunner();

let mainWindow = null;
let tools = null;
let shareServer = null;
/** The most recent prepared project, so Build and Burn do not redo encoding. */
let prepared = null;

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 660,
    // A deliberate dark chrome colour so the window does not flash white before
    // the interface paints, which looks like a glitch on a slow machine.
    backgroundColor: '#1b1a18',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs require() for the IPC surface
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Show only once the first frame is ready.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Keep the interface in step when a job changes state.
  const pushState = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('job:state', status);
    }
  };
  jobs.on('state', pushState);
  jobs.on('log', (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('job:log', line);
    }
  });
}

function buildMenuBar() {
  const send = (channel, payload) => () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const template = [
    {
      label: 'Burnhouse',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Setup\u2026', accelerator: 'CmdOrCtrl+,', click: send('menu:setup') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('menu:new-project') },
        { label: 'Open Project\u2026', accelerator: 'CmdOrCtrl+O', click: send('menu:open-project') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: send('menu:save-project') },
        { label: 'Save Project As\u2026', accelerator: 'CmdOrCtrl+Shift+S', click: send('menu:save-project-as') },
        { label: 'Close Project (Projects Home)', accelerator: 'CmdOrCtrl+W', click: send('menu:close-project') },
        { type: 'separator' },
        { label: 'Add Videos\u2026', accelerator: 'CmdOrCtrl+Shift+O', click: send('menu:add-videos') },
        { type: 'separator' },
        { label: 'Build Disc Image\u2026', accelerator: 'CmdOrCtrl+B', click: send('menu:build-image') },
        { label: 'Burn Disc\u2026', accelerator: 'CmdOrCtrl+Shift+B', click: send('menu:burn') },
        { type: 'separator' },
        { label: 'Reveal Working Folder', click: send('menu:reveal-work') },
        ...(process.platform !== 'darwin'
          ? [
              { type: 'separator' },
              { label: 'Exit', accelerator: 'Alt+F4', click: () => app.quit() },
            ]
          : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Slides', accelerator: 'CmdOrCtrl+1', click: send('menu:step', 'slides') },
        { label: 'Testing', accelerator: 'CmdOrCtrl+2', click: send('menu:step', 'testing') },
        { label: 'Finish', accelerator: 'CmdOrCtrl+3', click: send('menu:step', 'finish') },
        { type: 'separator' },
        { label: 'Show Activity Log', accelerator: 'CmdOrCtrl+L', click: send('menu:log') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'How to Use Burnhouse', click: send('menu:help') },
        { label: 'Share Files From This Computer\u2026', click: send('menu:share') },
        { type: 'separator' },
        {
          label: 'Open Working Folder in Finder',
          click: () => openPath(settingsStore.resolveWorkDir(settingsStore.read())),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openPath(target) {
  if (!target) return;
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    /* if it cannot be created, let the OS complain */
  }
  shell.openPath(target);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      // Errors cross the bridge as plain data. A rejected promise would give
      // the renderer an opaque "Error invoking remote method" string instead of
      // the message written for the user.
      return {
        ok: false,
        error: String((err && err.message) || err),
        aborted: Boolean(err && (err.isAbort || err.name === 'AbortError')),
      };
    }
  });
}

function registerIpc() {
  // ---- environment -------------------------------------------------------
  handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    isDev,
    packaged: app.isPackaged,
  }));

  handle('tools:detect', async () => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const versions = {};
    versions.ffmpeg = await toolVersion(tools.ffmpeg, ['-version']);
    versions.ffprobe = await toolVersion(tools.ffprobe, ['-version']);
    versions.dvdauthor = await toolVersion(tools.dvdauthor, ['--version']);
    versions.spumux = await toolVersion(tools.spumux, ['--version']);
    versions.hdiutil = await toolVersion(tools.hdiutil, ['-version']);
    return { tools, versions, workDir: settingsStore.resolveWorkDir(settings) };
  });

  handle('settings:get', async () => settingsStore.read());
  handle('settings:set', async (patch) => settingsStore.write(patch));

  // ---- projects ----------------------------------------------------------
  handle('project:list-recent', async () => settingsStore.listRecentProjects());

  handle('project:save', async (project) => settingsStore.saveProject(project));

  handle('project:load', async (payload) => settingsStore.loadProject(payload.idOrPath));

  handle('project:delete', async (payload) => settingsStore.deleteProject(payload.id));

  handle('project:save-dialog', async (defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Project As',
      buttonLabel: 'Save Project',
      defaultPath: `${defaultName || 'My DVD'}.burnhouse`,
      filters: [{ name: 'Burnhouse Project', extensions: ['burnhouse', 'json'] }],
    });
    if (result.canceled) return { canceled: true, filePath: null };
    return { canceled: false, filePath: result.filePath };
  });

  handle('project:open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Burnhouse Project',
      buttonLabel: 'Open Project',
      properties: ['openFile'],
      filters: [
        { name: 'Burnhouse Project', extensions: ['burnhouse', 'json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { canceled: true, filePath: null };
    return { canceled: false, filePath: result.filePaths[0] };
  });

  // ---- files -------------------------------------------------------------
  handle('dialog:add-videos', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add videos to the disc',
      buttonLabel: 'Add',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'vob', 'ts', 'mts', 'm2ts', '3gp', 'dv', 'divx'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { canceled: true, files: [] };
    return { canceled: false, files: result.filePaths };
  });

  handle('dialog:pick-folder', async (options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose a folder',
      buttonLabel: options.buttonLabel || 'Choose',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] };
  });

  handle('dialog:pick-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a picture for the menu',
      buttonLabel: 'Use Picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'] }],
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] };
  });

  handle('dialog:save-image', async (defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save the disc image',
      buttonLabel: 'Save',
      defaultPath: path.join(
        settingsStore.resolveWorkDir(settingsStore.read()),
        `${defaultName || 'DISC'}.iso`
      ),
      filters: [{ name: 'Disc image', extensions: ['iso'] }],
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePath };
  });

  // The renderer has no filesystem access, so a chosen picture is handed over
  // as a data URL. Everything downstream — preview, offscreen render, saved
  // deck — then carries the picture itself rather than a path that may not
  // resolve later.
  handle('files:read-image', async (target) => {
    if (!target) throw new Error('No picture was chosen.');
    return deckRender.readImageAsDataUrl(target);
  });

  /**
   * Playable URLs for local video files.
   *
   * The simulator plays the original files, and the renderer cannot turn a
   * filesystem path into a URL that Chromium will accept — `file:///C:/...` and
   * `file:///Users/...` are not the same shape and a bare path is refused
   * outright. pathToFileURL gets it right on both platforms, and doing it here
   * means the renderer has the URL in hand before playback starts rather than
   * discovering it cannot play after the key press.
   */
  handle('files:media-urls', async (paths) => {
    const { pathToFileURL } = require('url');
    const out = {};
    for (const target of (paths || []).filter(Boolean)) {
      try {
        out[target] = pathToFileURL(target).href;
      } catch {
        /* a path that cannot be turned into a URL simply has no entry */
      }
    }
    return out;
  });

  // ---- probing -----------------------------------------------------------
  handle('videos:inspect', async (payload) => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const project = pipeline.normaliseProject(payload || {});
    const result = await pipeline.inspect(project, { tools });

    /*
      A frame from each video, so it can be shown on a slide.

      Done here, as part of reading the videos, rather than when one is dropped
      onto a slide: by the time she drags something she is waiting for it to
      appear, and a frame extraction takes about a second. Getting it now means
      the drop is instant.

      A failure is reported as a missing poster and never as an error: a video
      with no picture must still be usable on the disc.
    */
    const videos = await Promise.all(
      result.videos.map(async (video) => ({
        id: video.id,
        path: video.path,
        name: video.name,
        duration: video.duration,
        probe: video.probe,
        sizeBytes: video.bytes,
        poster: await extractPoster(tools.ffmpeg, video.path, posterSeek(video)),
      }))
    );

    return {
      videos,
      errors: result.errors.map((e) => ({ name: e.video.name, path: e.video.path, error: e.error })),
      totalSeconds: result.totalSeconds,
      plan: result.plan,
    };
  });

  handle('deck:presets', async () => ({
    themes: Object.values(deckModel.THEMES),
    fonts: deckModel.FONTS,
    textSizes: deckModel.TEXT_SIZES,
    buttonStyles: slideLayout.BUTTON_STYLES,
    maxButtonsPerSlide: deckModel.MAX_BUTTONS_PER_SLIDE,
    safeMargin: deckModel.SAFE_MARGIN,
    raster: deckModel.RASTER,
    // The bounds a typed text size is clamped to. The editor shows them on the
    // number field; the deck enforces them on the way in, and one source means
    // the two cannot disagree.
    textSizeMin: deckModel.TEXT_SIZE_MIN,
    textSizeMax: deckModel.TEXT_SIZE_MAX,
    // How much wider the menu raster appears on a television than it is in
    // pixels. The editor needs it so its preview matches what the disc does.
    stretch: slideLayout.rasterStretch(),
    displayAspect: slideLayout.MENU_DISPLAY_ASPECT,
    // The colours and opacity the burned menu highlights its buttons with, so
    // the simulator lights them up exactly as the disc will.
    highlightColor: '#e0a34a',
    selectColor: '#f2c477',
    highlightOpacity: 84 / 255,
    selectOpacity: 210 / 255,
  }));

  /**
   * The disc's navigation graph, for the simulator.
   *
   * Built by the same function the burn uses, from the same deck, so what the
   * simulator plays back is what the disc does — not a second implementation
   * that merely looks similar.
   */
  handle('deck:disc-model', async (payload) => {
    const model = dvdModel.buildDiscModel({
      deck: (payload && payload.deck) || {},
      videos: (payload && payload.videos) || [],
      aspect: (payload && payload.aspect) || '16:9',
    });
    // The layout is already available to the renderer, and a Map does not
    // survive the trip, so only the navigation graph is sent.
    return {
      aspect: model.aspect,
      firstPlay: model.firstPlay,
      menus: model.menus,
      titles: model.titles,
      // What plays next after each film, so finishing one moves on exactly as
      // the burned disc will.
      nextTitleByNumber: model.nextTitleByNumber,
    };
  });

  /**
   * Lay out the deck so the editor can draw it.
   *
   * The editor draws with the same module the disc renderer uses, so it is
   * handed exactly the layout the pipeline would render — the same structure,
   * not a summary of it. Anything else would reintroduce the chance that the
   * preview and the disc disagree.
   */
  handle('deck:layout', async (payload) => {
    const deck = deckModel.normaliseDeck(payload.deck || {});
    const layout = slideLayout.layoutDeck(deck);
    return {
      raster: deckModel.RASTER,
      problems: layout.problems,
      slides: layout.slides,
    };
  });

  /**
   * A single frame from a video, for use as a thumbnail on a slide.
   *
   * Extracted once and cached by file path and modification time, because
   * pulling a frame out of a two hour file is not something to do while
   * somebody is dragging things around.
   */
  handle('video:poster', async (payload) => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    if (!tools.ffmpeg || !payload || !payload.path) return { dataUrl: null };
    return { dataUrl: await extractPoster(tools.ffmpeg, payload.path, payload.at) };
  });

  // ---- drives ------------------------------------------------------------
  handle('drives:list', async () => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const result = await disc.listDrives({
      drutil: tools.drutil,
      hdiutil: tools.hdiutil,
      diskutil: tools.diskutil,
    });
    return { ...result, note: result.note || (await disc.platformDiscNote()) };
  });

  // ---- jobs --------------------------------------------------------------
  handle('job:status', async () => jobs.status);
  handle('job:cancel', async () => jobs.cancel());
  handle('job:clear-log', async () => {
    jobs.clearLog();
    return true;
  });

  handle('job:build', async (payload) => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const project = pipeline.normaliseProject(payload.project || payload);
    // One folder per project, so builds do not overwrite each other and a build
    // survives upgrading the app.
    const workDir = settingsStore.resolveWorkDir(settings, (payload.project || {}).id);

    const result = await jobs.run('build', async (ctx) => {
      ctx.onProgress({ stage: 'inspect', fraction: 0, message: 'Reading your videos\u2026' });

      const built = await pipeline.prepare(project, {
        tools,
        workDir,
        onProgress: ctx.onProgress,
        onLog: ctx.log,
        signal: ctx.signal,
        BrowserWindow,
      });

      // Read the finished streams back and confirm they are what was asked for.
      // Catching a spec problem here costs seconds; catching it after a burn
      // costs a blank disc.
      ctx.onProgress({ stage: 'verify', fraction: 0.6, message: 'Checking the disc\u2026' });
      const verification = await pipeline.verifyDisc(built, { tools });
      if (!verification.ok) {
        ctx.log('Checks that did not pass:');
        for (const problem of verification.problems) ctx.log(`  ${problem}`);
      }

      prepared = { ...built, project, workDir, verification };

      return {
        videoTsDir: built.videoTsDir,
        volumeLabel: built.volumeLabel,
        videoCount: built.videos.length,
        slideCount: built.menus.length,
        failed: built.failed.map((f) => ({ name: f.name, error: f.encodeError })),
        totalSeconds: built.totalSeconds,
        sizeBytes: folderSize(built.videoTsDir),
        videoBitrate: built.plan.videoBitrate,
        verification,
        slideProblems: built.slideProblems || [],
      };
    });

    return result;
  });

  handle('job:image', async (payload) => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const target = payload && payload.path;
    const source = prepared || (await requirePrepared(payload));

    const result = await jobs.run('image', async (ctx) => {
      const out = await pipeline.makeImage(source, {
        tools,
        outputIso: target,
        onProgress: (f) =>
          ctx.onProgress({ stage: 'image', fraction: f, message: 'Building the disc image\u2026' }),
        signal: ctx.signal,
      });
      return { isoPath: out.isoPath, sizeBytes: safeSize(out.isoPath) };
    });

    return result;
  });

  handle('job:burn', async (payload) => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    const source = prepared || (await requirePrepared(payload));

    const result = await jobs.run('burn', async (ctx) => {
      const out = await pipeline.burn(source, {
        tools,
        device: (payload && payload.device) || settings.lastDevice || null,
        onProgress: ctx.onProgress,
        signal: ctx.signal,
        verify: settings.verifyBurn !== false,
        workDir: source.workDir,
        log: ctx.log,
      });

      if (payload && payload.device) settingsStore.write({ lastDevice: payload.device });
      return { isoPath: out.isoPath };
    });

    return result;
  });

  /*
    What is already built for this project, and whether it is still current.

    The Finish page asks this on the way in, so a prepared disc from an earlier
    session is offered rather than silently rebuilt — and so a project that has
    been changed since says so instead of quietly burning the older disc.
  */
  handle('job:built', async (payload) => {
    const settings = settingsStore.read();
    const project = pipeline.normaliseProject(payload.project || payload);
    const workDir = settingsStore.resolveWorkDir(settings, (payload.project || {}).id);
    const record = pipeline.readBuildRecord(workDir);

    if (!record) return { built: false, upToDate: false };

    const expected = pipeline.projectFingerprint(project);
    const structurePresent = fs.existsSync(path.join(workDir, 'author', 'VIDEO_TS', 'VIDEO_TS.IFO'));

    return {
      built: true,
      upToDate: record.fingerprint === expected && structurePresent,
      // Present so a stale build can say what it was, rather than only that it
      // is out of date.
      manifest: {
        volumeLabel: record.volumeLabel || null,
        builtAt: record.builtAt || null,
        videoCount: record.videoCount || 0,
        slideCount: record.slideCount || 0,
        totalSeconds: record.totalSeconds || 0,
        app: record.app || null,
      },
      workDir,
    };
  });

  handle('job:save-folder', async (payload) => {
    const source = prepared || (await requirePrepared(payload));
    const destination = payload && payload.path;
    if (!destination) throw new Error('Choose where to save the disc files.');
    return pipeline.saveFolder(source, destination, () => {});
  });

  handle('disc:eject', async () => {
    const settings = settingsStore.read();
    tools = detectTools(settings);
    if (!tools.drutil) throw new Error('The disc drive tool is not available.');
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile(tools.drutil, ['eject'], { windowsHide: true }, (err) =>
        err ? reject(new Error(`Could not eject: ${err.message}`)) : resolve()
      );
    });
    return true;
  });

  handle('shell:open', async (target) => {
    if (!target) return false;
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
    return true;
  });

  handle('shell:reveal', async (target) => {
    if (!target) return false;
    if (fs.existsSync(target)) {
      shell.showItemInFolder(target);
      return true;
    }
    // Fall back to the containing folder so a missing file still helps.
    const dir = path.dirname(target);
    if (fs.existsSync(dir)) {
      shell.openPath(dir);
      return true;
    }
    return false;
  });

  // ---- sharing server ----------------------------------------------------
  handle('server:start', async (payload) => {
    const settings = settingsStore.read();
    const port = (payload && payload.port) || settings.server.port || 8137;
    if (shareServer) {
      return { ...shareServer.info(), alreadyRunning: true };
    }
    shareServer = await startServer({
      port,
      workDir: settingsStore.resolveWorkDir(settings),
      distDir: path.join(app.getAppPath(), 'dist'),
      onLog: (line) => jobs.log(`[share] ${line}`),
    });
    settingsStore.write({ server: { enabled: true, port } });
    return shareServer.info();
  });

  handle('server:stop', async () => {
    if (!shareServer) return { stopped: false };
    await shareServer.stop();
    shareServer = null;
    settingsStore.write({ server: { enabled: false } });
    return { stopped: true };
  });

  handle('server:info', async () => (shareServer ? shareServer.info() : { running: false }));
}

/**
 * The prepared disc to burn, from this session or from disk.
 *
 * It used to be this session only, so quitting the app — or upgrading it, which
 * is the same thing after an install — meant re-encoding everything before a
 * disc could be burned. The prepared structure belongs to the project and lives
 * in the user's own folder, so it is read back from there instead.
 *
 * Only if the project still matches. A changed project must be built again, and
 * says so rather than quietly burning the older disc.
 */
async function requirePrepared(payload) {
  if (prepared) return prepared;

  const project = pipeline.normaliseProject((payload && payload.project) || payload || {});
  const settings = settingsStore.read();
  const workDir = settingsStore.resolveWorkDir(settings, (payload && payload.project || {}).id);
  const record = pipeline.readBuildRecord(workDir);
  const videoTsDir = path.join(workDir, 'author', 'VIDEO_TS');

  const structurePresent =
    fs.existsSync(path.join(videoTsDir, 'VIDEO_TS.IFO')) &&
    fs.existsSync(path.join(videoTsDir, 'VIDEO_TS.BUP'));

  if (record && structurePresent) {
    const fingerprint = pipeline.projectFingerprint(project);
    if (record.fingerprint !== fingerprint) {
      throw new Error(
        'The project has changed since this disc was built. Press "Build the Disc" ' +
          'on the Finish step, then burn it.'
      );
    }
    return {
      videoTsDir,
      workDir,
      volumeLabel: record.volumeLabel,
      totalSeconds: record.totalSeconds || 0,
      fingerprint,
      builtAt: record.builtAt,
      fromDisk: true,
    };
  }

  throw new Error(
    'Build the disc first. Press "Build the Disc" on the Finish step, then burn it.'
  );
}

function folderSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const stat = fs.statSync(path.join(dir, entry));
      if (stat.isFile()) total += stat.size;
    }
  } catch {
    /* a missing folder reports zero, which is honest */
  }
  return total;
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Where to take a frame from.
 *
 * A tenth of the way in, clamped: the very start of a file is often a black
 * frame or a title card, and the very end is often nothing at all. Clamping
 * means a three-second clip and a three-hour film both get a useful frame.
 */
function posterSeek(video) {
  const duration = Number(video && video.duration) || 0;
  if (duration <= 0) return 1;
  return Math.max(1, Math.min(30, duration * 0.1));
}

/**
 * Pull one frame out of a video as a data URL, for a slide tile.
 *
 * Cached on disk under the application's cache folder and keyed by the file
 * path, its size and its modification time. Re-extracting a frame from a long
 * video every time a slide is redrawn would make the editor feel broken, and
 * keying on size and mtime means an edited file is still picked up.
 *
 * Returns null when a frame cannot be had. That is not an error: the tile draws
 * without it.
 */
const posterCache = new Map();

/**
 * Why the last poster extraction failed, keyed by video path.
 *
 * Kept rather than discarded: a tile with no picture is a visible symptom, and
 * "nothing happened" is not a diagnosis. This is what the Setup panel reports.
 */
const posterFailures = new Map();

function notePosterFailure(videoPath, reason) {
  posterFailures.set(videoPath, String(reason));
  console.warn(`[poster] ${videoPath}: ${reason}`);
}

async function extractPoster(ffmpegPath, videoPath, atSeconds) {
  if (!ffmpegPath) {
    notePosterFailure(videoPath, 'the video tool is not available');
    return null;
  }
  if (!videoPath) {
    notePosterFailure(videoPath, 'no file path');
    return null;
  }

  const cacheKey = `${videoPath}:${Math.round((Number(atSeconds) || 0) * 10)}`;
  if (posterCache.has(cacheKey)) return posterCache.get(cacheKey);

  let stamp = '';
  try {
    const stat = fs.statSync(videoPath);
    stamp = `${stat.size}-${Math.round(stat.mtimeMs)}`;
  } catch (err) {
    // The file is gone or unreadable; there is no frame to be had.
    notePosterFailure(videoPath, `cannot read the file: ${err.message}`);
    posterCache.set(cacheKey, null);
    return null;
  }

  let cacheDir;
  try {
    cacheDir = path.join(app.getPath('userData'), 'posters');
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    notePosterFailure(videoPath, `cannot use the poster folder: ${err.message}`);
    return null;
  }

  const hash = crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 16);
  const target = path.join(cacheDir, `${hash}-${stamp}.jpg`);

  if (!fs.existsSync(target)) {
    const result = await new Promise((resolve) => {
      let stderr = '';
      const child = spawn(
        ffmpegPath,
        [
          '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
          // Seeking before the input makes ffmpeg jump rather than decode the
          // whole file up to that point.
          '-ss', String(atSeconds),
          '-i', videoPath,
          '-frames:v', '1',
          /*
            Sized and compressed for a menu tile, not for a photograph.

            320 pixels wide at quality 5 is sharp enough for a 720x480 menu and
            keeps each frame to a few tens of kilobytes — which matters, because
            these travel inside the deck and are re-rendered every time a slide
            changes.
          */
          '-vf', 'scale=320:-2:flags=lanczos',
          '-q:v', '5',
          target,
        ],
        { windowsHide: true }
      );
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-600);
      });
      child.on('error', (err) => resolve({ ok: false, reason: `could not start ffmpeg: ${err.message}` }));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(target)) return resolve({ ok: true });
        resolve({
          ok: false,
          reason: `ffmpeg exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
        });
      });
    });

    if (!result.ok) {
      notePosterFailure(videoPath, result.reason);
      posterCache.set(cacheKey, null);
      return null;
    }
  }

  try {
    const dataUrl = deckRender.readImageAsDataUrl(target);
    posterCache.set(cacheKey, dataUrl);
    posterFailures.delete(videoPath);
    return dataUrl;
  } catch (err) {
    notePosterFailure(videoPath, `could not read the frame: ${err.message}`);
    posterCache.set(cacheKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Only one copy of Burnhouse may run: two instances writing into the same
// working folder would fight over the same VIDEO_TS and corrupt each other.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    settingsStore.configure(app.getPath('userData'));
    tools = detectTools(settingsStore.read());

    registerIpc();
    buildMenuBar();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', async () => {
    if (shareServer) {
      try {
        await shareServer.stop();
      } catch {
        /* shutting down anyway */
      }
    }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Stop any running encode so a half-written VOB is not left mid-buffer.
    jobs.cancel();
  });
}
