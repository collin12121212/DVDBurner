'use strict';

/**
 * Focused tests for the things that make a build fast.
 *
 * Three changes, and each one is a claim that has to hold or the disc is wrong
 * rather than slow:
 *
 *   - a title whose source and settings have not changed is reused instead of
 *     re-encoded, and anything that would change the output invalidates it;
 *   - a source that already is a DVD title is copied rather than encoded, and
 *     nothing that would need converting is copied;
 *   - hdiutil is told not to verify when verification is off, because its own
 *     default is to verify and silence does not mean no.
 *
 * Everything here is pure filesystem and argument inspection, so it runs in well
 * under a second and needs no video tools, no drive and no disc.
 *
 * Run with:  npm run test:speed
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const encode = require('../src/core/encode');
const disc = require('../src/core/disc');
const probeMod = require('../src/core/probe');
const pipeline = require('../src/core/pipeline');
const spec = require('../src/core/dvd_spec');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: String((err && err.message) || err) });
    console.log(`  FAIL ${name}`);
    console.log(`       ${String((err && err.message) || err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${tag}-`));
}

function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------- fixtures ---

const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
const ASPECT = { ratio: '16:9' };

/** The options block the pipeline builds, so the tests key on the same shape. */
function options(overrides = {}) {
  return {
    format: plan.format.id,
    width: plan.format.width,
    height: plan.format.height,
    fps: plan.format.fps,
    gop: plan.gop,
    videoBitrate: plan.videoBitrate,
    audioBitrate: plan.audioBitrate,
    muxrate: plan.muxrate,
    audioChannels: plan.audio.channels,
    aspect: ASPECT.ratio,
    hasAudio: true,
    ...overrides,
  };
}

function sourceFile(dir, name = 'episode.mp4', bytes = 1024) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

/** A probe record shaped like the ones probe.js really produces. */
function probeFor(file, overrides = {}) {
  return {
    path: file,
    name: path.basename(file),
    width: 1920,
    height: 1080,
    fps: 29.97,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    displayAspect: '16:9',
    bitrate: 8000000,
    hasAudio: true,
    audioCodec: 'aac',
    audioChannels: 2,
    audioSampleRate: 48000,
    ...overrides,
  };
}

/** A title folder holding one VOB, with a cache record claiming it is current. */
function cachedTitle(dir, fingerprint, { bytes = 4096, mode = 'encode', parts = 1 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 1; i <= parts; i += 1) {
    const file = path.join(dir, `VTS_01_${i}.VOB`);
    fs.writeFileSync(file, Buffer.alloc(bytes, 3));
    files.push({ file, bytes });
  }
  encode.writeTitleCache(dir, { fingerprint, parts: files, mode });
  return files;
}

// ---------------------------------------------------------- title cache ---

section('Reusing a title that has not changed');

test('an unchanged title is found and reused', () => {
  const dir = tmpdir('cache-hit');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const probe = probeFor(input);

  const key = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });
  const written = cachedTitle(titleDir, key);

  const found = encode.readTitleCache(titleDir, key);
  assert(found, 'The title should have been reused');
  assertEqual(found.parts.length, 1, 'It should carry the parts it found');
  assertEqual(found.parts[0].file, written[0].file, 'The part path must be the real one');
  assertEqual(found.parts[0].bytes, 4096, 'The part size must be carried through');
  assertEqual(found.mode, 'encode', 'The mode should be remembered');
});

test('the parts are returned as absolute paths, whatever the record held', () => {
  const dir = tmpdir('cache-paths');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });

  fs.mkdirSync(titleDir, { recursive: true });
  fs.writeFileSync(path.join(titleDir, 'VTS_01_1.VOB'), Buffer.alloc(100, 1));
  // A record written somewhere else, or by an older build, must still resolve
  // against the folder it is read from — not against whatever it recorded.
  encode.writeTitleCache(titleDir, {
    fingerprint: key,
    parts: [{ file: '/somewhere/else/entirely/VTS_01_1.VOB', bytes: 100 }],
    mode: 'copy',
  });

  const found = encode.readTitleCache(titleDir, key);
  assert(found, 'A bare filename must be resolved from the title folder');
  assertEqual(found.parts[0].file, path.join(titleDir, 'VTS_01_1.VOB'), 'Path must be rebuilt locally');
  assertEqual(found.mode, 'copy', 'A copied title reports itself as copied');
});

test('a changed source file invalidates the title', () => {
  const dir = tmpdir('cache-source');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const probe = probeFor(input);
  const key = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key);

  // Same path, different contents — the case that a path-only cache would miss.
  fs.writeFileSync(input, Buffer.alloc(2048, 9));
  const after = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  assert(after !== key, 'Replacing the file must change the fingerprint');
  assertEqual(encode.readTitleCache(titleDir, after), null, 'A changed source must not be reused');
});

test('a touch that changes nothing but the clock is noticed too', () => {
  const dir = tmpdir('cache-mtime');
  const input = sourceFile(dir);
  const probe = probeFor(input);
  const before = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  const later = new Date(Date.now() + 60000);
  fs.utimesSync(input, later, later);
  const after = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  assert(after !== before, 'A rewritten file with the same size must still invalidate');
});

test('every setting that changes the output invalidates the title', () => {
  const dir = tmpdir('cache-settings');
  const input = sourceFile(dir);
  const probe = probeFor(input);
  const base = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  const changes = {
    'the video bitrate': { videoBitrate: plan.videoBitrate - 200000 },
    'the audio bitrate': { audioBitrate: 448000 },
    'the mux rate': { muxrate: plan.muxrate - 100000 },
    'the GOP length': { gop: 15 },
    'the frame rate': { fps: 25 },
    'the raster height': { height: 576 },
    'the shape': { aspect: '4:3' },
    'whether there is sound': { hasAudio: false },
    'the channel count': { audioChannels: 6 },
  };

  for (const [what, change] of Object.entries(changes)) {
    const key = encode.titleFingerprint({
      input,
      probe,
      options: options(change),
      durationSeconds: 600,
    });
    assert(key !== base, `Changing ${what} must force the title to be prepared again`);
  }

  // And a re-measured duration, which is what -t is cut to.
  const shorter = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 900 });
  assert(shorter !== base, 'A different duration must force the title to be prepared again');
});

test('the colour matrix tag invalidates the title', () => {
  const dir = tmpdir('cache-matrix');
  const input = sourceFile(dir);
  const hd = encode.titleFingerprint({
    input,
    probe: probeFor(input, { colorSpace: 'bt709' }),
    options: options(),
    durationSeconds: 600,
  });
  const sd = encode.titleFingerprint({
    input,
    probe: probeFor(input, { colorSpace: 'bt470bg' }),
    options: options(),
    durationSeconds: 600,
  });
  assert(hd !== sd, 'A different source colour matrix is a different conversion');
});

test('a recorded title whose file is the wrong length is not reused', () => {
  const dir = tmpdir('cache-short');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key, { bytes: 4096 });

  // An interrupted run leaves the right name at the wrong length. Reusing it
  // would put a truncated title on the disc and nothing would say so.
  fs.writeFileSync(path.join(titleDir, 'VTS_01_1.VOB'), Buffer.alloc(512, 1));
  assertEqual(encode.readTitleCache(titleDir, key), null, 'A short part must not be reused');

  fs.rmSync(path.join(titleDir, 'VTS_01_1.VOB'));
  assertEqual(encode.readTitleCache(titleDir, key), null, 'A missing part must not be reused');
});

test('a record from an older encoder is not reused', () => {
  const dir = tmpdir('cache-revision');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key);

  // The ghosting fix is the reason this matters: same source, same settings, a
  // different and correct output. A cache that ignored the revision would have
  // quietly kept the broken stream.
  const recordPath = path.join(titleDir, '.encode.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.revision = encode.ENCODE_REVISION - 1;
  fs.writeFileSync(recordPath, JSON.stringify(record));

  assertEqual(encode.readTitleCache(titleDir, key), null, 'An older recipe must not be reused');
});

test('a corrupted or absent record is not reused', () => {
  const dir = tmpdir('cache-broken');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });

  assertEqual(encode.readTitleCache(titleDir, key), null, 'No folder at all is not a hit');

  fs.mkdirSync(titleDir, { recursive: true });
  assertEqual(encode.readTitleCache(titleDir, key), null, 'No record is not a hit');

  fs.writeFileSync(path.join(titleDir, '.encode.json'), '{ this is not json');
  assertEqual(encode.readTitleCache(titleDir, key), null, 'An unreadable record is not a hit');
});

test('clearing the cache removes every prepared title', () => {
  const root = tmpdir('cache-clear');
  const input = sourceFile(root);
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });
  cachedTitle(path.join(root, 'titles', 'title_1'), key);
  cachedTitle(path.join(root, 'titles', 'title_2'), key);

  encode.clearTitleCache(root);
  assertEqual(fs.existsSync(path.join(root, 'titles')), false, 'The titles folder should be gone');
  assertEqual(encode.readTitleCache(path.join(root, 'titles', 'title_1'), key), null, 'And nothing is reusable');
});

test('title folders past the end of the video list are removed', () => {
  const root = tmpdir('cache-prune');
  const input = sourceFile(root);
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });
  cachedTitle(path.join(root, 'titles', 'title_1'), key);
  cachedTitle(path.join(root, 'titles', 'title_2'), key);
  cachedTitle(path.join(root, 'titles', 'title_3'), key);

  assertEqual(encode.pruneTitleDirs(root, 2), 1, 'One folder should have been removed');
  assertEqual(fs.existsSync(path.join(root, 'titles', 'title_2')), true, 'A folder still in use stays');
  assertEqual(fs.existsSync(path.join(root, 'titles', 'title_3')), false, 'The one past the end goes');
  assertEqual(encode.pruneTitleDirs(root, 2), 0, 'Running it again removes nothing');
});

// ------------------------------------------------------------- remuxing ---

section('Copying a source that is already a DVD title');

const NTSC = spec.resolveFormat
  ? spec.resolveFormat('ntsc')
  : { width: 720, height: 480, fps: 30000 / 1001 };

function dvdProbe(overrides = {}) {
  return probeFor('/movies/VIDEO_TS/VTS_01_1.VOB', {
    width: 720,
    height: 480,
    fps: 30000 / 1001,
    videoCodec: 'mpeg2video',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt470bg',
    displayAspect: '16:9',
    bitrate: 6000000,
    audioCodec: 'ac3',
    audioChannels: 2,
    audioSampleRate: 48000,
    ...overrides,
  });
}

const REMUX_CONTEXT = { format: NTSC, aspect: '16:9', muxrate: plan.muxrate };

test('a DVD-quality .vob is copied rather than encoded', () => {
  const verdict = encode.canRemux(dvdProbe(), REMUX_CONTEXT);
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('anything that would need converting is encoded instead', () => {
  const cases = {
    'a source that is not MPEG-2': dvdProbe({ videoCodec: 'h264' }),
    'the wrong raster': dvdProbe({ width: 704 }),
    'the wrong frame rate': dvdProbe({ fps: 25 }),
    'a colour format DVD cannot carry': dvdProbe({ pixelFormat: 'yuv422p' }),
    'a 4:3 source on a 16:9 disc': dvdProbe({ displayAspect: '4:3' }),
    'a source whose shape is unknown': dvdProbe({ displayAspect: null }),
    'a source above the disc budget': dvdProbe({ bitrate: plan.muxrate + 1000000 }),
    // A .vob carries an average bitrate of almost exactly its own mux rate, so a
    // fraction over is measurement noise rather than a source too big to fit.
    'a source a long way above the disc budget': dvdProbe({ bitrate: plan.muxrate * 1.5 }),
    'a source whose bitrate is unknown': dvdProbe({ bitrate: null }),
    'a plain .mpg that may not be a compliant stream': dvdProbe({ path: '/movies/clip.mpg' }),
  };

  for (const [what, probe] of Object.entries(cases)) {
    const verdict = encode.canRemux(probe, REMUX_CONTEXT);
    assert(!verdict.ok, `${what} must not be copied`);
    assert(verdict.reason, `${what} must say why`);
  }
});

test('a source right at the disc budget is still copied', () => {
  // The muxer pads a DVD stream to exactly its mux rate, so a file this program
  // produced sits on the line. Refusing it would mean never copying the one kind
  // of source the copy path exists for.
  const verdict = encode.canRemux(dvdProbe({ bitrate: plan.muxrate }), REMUX_CONTEXT);
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('a 4:3 disc copies a 4:3 source', () => {
  const verdict = encode.canRemux(dvdProbe({ displayAspect: '4:3' }), {
    ...REMUX_CONTEXT,
    aspect: '4:3',
  });
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('the copy argument list asks for no conversion at all', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/titles/title_1/VTS_01_1.VOB',
    plan: { ...plan, hasAudio: true, probe: dvdProbe() },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must be copied');
  assert(joined.includes('-c:a copy'), 'Compliant sound must be copied too');
  assert(joined.includes('-f dvd'), 'It must still be remultiplexed as a DVD stream');
  assert(joined.includes('-muxrate'), 'The mux rate still has to be within the disc budget');
  assert(joined.includes('-t 600'), 'The length is still imposed');

  // Every one of these describes a conversion, and a copy is the absence of one.
  for (const forbidden of ['-vf', '-c:v mpeg2video', '-s 720x480', '-aspect', '-r ']) {
    assert(!joined.includes(forbidden), `${forbidden} must not appear in a copy`);
  }
});

test('sound that needs converting is converted without touching the picture', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: {
      ...plan,
      hasAudio: true,
      // AAC is not something a DVD may carry, so the sound is re-encoded.
      probe: dvdProbe({ audioCodec: 'aac' }),
    },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must still be copied');
  assert(joined.includes('-c:a ac3'), 'The sound must be converted to AC-3');
  assert(joined.includes('-ar 48000'), 'At the 48 kHz a DVD requires');
});

test('a 5.1 source on a stereo disc has its sound converted, not copied', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: true, probe: dvdProbe({ audioChannels: 6 }) },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must still be copied');
  assert(joined.includes('-c:a ac3'), 'A channel count the disc plan did not budget for is converted');
  assert(!joined.includes('-c:a copy'), 'And must not be copied through as it stands');
});

test('a source with no sound is copied without inventing one', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: false, probe: dvdProbe({ hasAudio: false }) },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must be copied');
  assert(!joined.includes('0:a:0'), 'No audio stream should be mapped from a source that has none');
  // The silent track is multiplexed in afterwards, exactly as for an encoded
  // title, so this must not try to do it here.
  assert(!joined.includes('anullsrc'), 'Silence is added by the step after this one');
});

test('a plain MPEG-2 file at DVD resolution still goes through the encoder', () => {
  const input = '/movies/holiday.mpg';
  const probe = dvdProbe({ path: input });
  assertEqual(encode.canRemux(probe, REMUX_CONTEXT).ok, false, 'A .mpg is not proof of a compliant stream');

  const args = encode.buildEncodeArgs({
    input,
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: true, probe },
    durationSeconds: 600,
    aspect: ASPECT,
  });
  assert(args.join(' ').includes('-c:v mpeg2video'), 'It must be encoded');
});

// --------------------------------------------------------- probe shapes ---

section('Reading the shape a video is meant to be seen in');

test('a widescreen DVD is 16:9 from its anamorphic flag', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, sample_aspect_ratio: '32/27' }),
    '16:9',
    '32:27 on a 720x480 frame is widescreen'
  );
});

test('a full-frame DVD is 4:3 from its anamorphic flag', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, sample_aspect_ratio: '8/9' }),
    '4:3',
    '8:9 on a 720x480 frame is full frame'
  );
});

test('a stated shape is believed over a derived one', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, display_aspect_ratio: '16:9', sample_aspect_ratio: '8/9' }),
    '16:9',
    'ffprobe having worked it out is the better answer'
  );
});

test('square-pixel sources are read from their pixel count', () => {
  assertEqual(probeMod.displayAspectOf({ width: 1920, height: 1080, sample_aspect_ratio: '1/1' }), '16:9');
  assertEqual(probeMod.displayAspectOf({ width: 640, height: 480, sample_aspect_ratio: '1/1' }), '4:3');
});

test('a shape a DVD cannot carry is reported as unknown, not forced', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 1920, height: 800, sample_aspect_ratio: '1/1' }),
    null,
    'Scope is not one of the two shapes a DVD has'
  );
  assertEqual(probeMod.displayAspectOf({ width: 0, height: 0 }), null, 'Nothing readable is nothing');
});

// ------------------------------------------------------------- burning ----

section('Telling hdiutil what to do about verification');

test('verification is asked for outright when it is wanted', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/disc.iso', verify: true });
  assert(args.includes('-verifyburn'), 'It should say so rather than relying on the default');
  assert(!args.includes('-noverify'), 'And must not also say the opposite');
});

test('verification is refused outright when it is not wanted', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/disc.iso', verify: false });
  // The whole point: hdiutil verifies by default, so saying nothing meant
  // verifying anyway and the setting saved nothing but claimed a shorter burn.
  assert(args.includes('-noverify'), 'Saying nothing is not the same as saying no');
  assert(!args.includes('-verifyburn'), 'The two must never both be passed');
});

test('the image is the second word and no device is named', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/My Disc.iso', verify: true });
  assertEqual(args[0], 'burn', 'It must be the burn verb');
  assertEqual(args[1], '/tmp/My Disc.iso', 'A path with a space is passed as one argument, untouched');
  assert(!args.includes('-device'), 'The drive path cannot be reconstructed safely');
});

// ------------------------------------------------------- disc fingerprint ---

section('Noticing a changed project');

test('the disc shape and the disc type are part of the fingerprint', () => {
  const root = tmpdir('fingerprint');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };

  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });
  const before = pipeline.projectFingerprint(base);

  // These two silently did not register before, so a finished build was offered
  // as still current after the whole disc had been switched to a different
  // shape or a different size of blank disc.
  const otherAspect = pipeline.projectFingerprint({ ...base, titleAspect: '4:3' });
  const otherDisc = pipeline.projectFingerprint({ ...base, discType: 'dvd9' });

  assert(otherAspect !== before, 'Changing the shape must be noticed');
  assert(otherDisc !== before, 'Changing the disc type must be noticed');
});

test('the disc title and the slides are part of the fingerprint', () => {
  const root = tmpdir('fingerprint-2');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });
  const before = pipeline.projectFingerprint(base);

  assert(pipeline.projectFingerprint({ ...base, discTitle: 'Other Trip' }) !== before, 'A renamed disc is a different disc');

  const moved = { ...base, deck: { ...base.deck, slides: [...base.deck.slides, { id: 's2' }] } };
  assert(pipeline.projectFingerprint(moved) !== before, 'A new slide is a different disc');
});

test('the app version and the tool paths are not part of the fingerprint', () => {
  const root = tmpdir('fingerprint-3');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip', themeId: 'charcoal' });
  const before = pipeline.projectFingerprint(base);

  // Upgrading the app, or moving the working folder, must not throw away an
  // hour of encoding — that is the whole reason the fingerprint is narrow.
  assertEqual(
    pipeline.projectFingerprint({ ...base, output: { workDir: 'C:\\somewhere\\else' } }),
    before,
    'Where the work is kept does not change the disc'
  );
});

test('the encoder recipe is part of the fingerprint', () => {
  const root = tmpdir('fingerprint-4');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const project = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });

  const payload = pipeline.fingerprintPayload(project);
  assertEqual(
    payload.encoderRevision,
    encode.ENCODE_REVISION,
    'The recipe revision has to be hashed, or a fix in the encoder cannot invalidate anything'
  );

  /*
    The case that matters, and the one that actually happened.

    A release that changes the encoder produces different bytes from a project
    that has not moved at all. If the fingerprint is the project alone, the disc
    prepared before that release still claims to be current, the Burn button goes
    straight to writing it, and the fix never reaches a disc. That is how a
    prepared disc from before the ghosting fix survived several releases.
  */
  const bumped = crypto
    .createHash('sha256')
    .update(JSON.stringify(pipeline.fingerprintPayload(project, encode.ENCODE_REVISION + 1)))
    .digest('hex');

  assert(
    bumped !== pipeline.projectFingerprint(project),
    'A new encoder recipe must make a prepared disc out of date'
  );
  assert(
    JSON.stringify(pipeline.fingerprintPayload(project, encode.ENCODE_REVISION + 1)) !==
      JSON.stringify(payload),
    'And the difference has to be in what is hashed, not only in the hash'
  );
});

test('the fingerprint is stable, so an unchanged project is not rebuilt', () => {
  const root = tmpdir('fingerprint-5');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };

  /*
    A deck is always supplied, by the editor, and its ids were minted once when
    the slides were made and have been carried in the project ever since. That
    is what makes the fingerprint stable across calls — and it has to be, because
    the fingerprint written by one build is compared against one computed by a
    later, separate call. If normalising the same project twice gave two answers,
    a prepared disc would look out of date to the very next question and would be
    rebuilt every single time, for ever.
  */
  const deck = {
    discTitle: 'Trip',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'slide_1',
        title: 'Trip',
        role: 'menu',
        themeId: 'charcoal',
        elements: [{ id: 'el_1', kind: 'text', text: 'Trip', x: 40, y: 44, width: 640 }],
      },
    ],
  };

  const build = () => pipeline.normaliseProject({ videos: [video], discTitle: 'Trip', deck });

  assertEqual(pipeline.projectFingerprint(build()), pipeline.projectFingerprint(build()), 'Asking twice must give the same answer, or nothing would ever be reused');

  // And the ids really are preserved rather than regenerated, which is what the
  // whole thing rests on.
  assertEqual(build().deck.slides[0].id, 'slide_1', 'A slide id must survive normalising');
  assertEqual(build().deck.slides[0].elements[0].id, 'el_1', 'And so must an element id');
});

// --------------------------------------------------------------------- go ---

console.log('');
if (failed) {
  console.log(`${failed} of ${passed + failed} checks failed.`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
} else {
  console.log(`All ${passed} checks passed.`);
}
