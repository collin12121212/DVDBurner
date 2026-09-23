'use strict';

/**
 * The prepared disc is reused, and only what changed is prepared again.
 *
 * This is the one test that runs the real pipeline: real ffmpeg, real menu
 * rendering in a real offscreen window, real dvdauthor. It exists because the
 * caching added between those stages is a claim about all of them at once — that
 * a second build with nothing changed writes the same disc without re-encoding
 * anything, and that changing a slide does not invalidate a film.
 *
 * It uses one three-second fixture twice, so it takes seconds rather than the
 * minutes it would with real footage, and it asserts on what is on disk: the
 * encoded title files must still be the very same files, by modification time.
 *
 * Run with:  npm run test:reuse
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const pipeline = require('../src/core/pipeline');
const { detectTools } = require('../src/core/tools');
const probeMod = require('../src/core/probe');

const FIXTURE = path.join(__dirname, 'fixtures', 'fixture_ntsc.mp4');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS ${name}`);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, message: String((err && err.message) || err) });
      console.log(`  FAIL ${name}`);
      console.log(`       ${String((err && err.message) || err)}`);
    });
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  SKIP ${name} \u2014 ${reason}`);
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

/**
 * What each prepared title looks like on disk: the files that were written, when
 * they were written, and how big they are.
 *
 * Modification time is the point. A rebuild that reuses a title leaves the file
 * exactly as it was; one that re-encodes it writes a new one, and no accounting
 * in the pipeline can hide that from the filesystem.
 */
function snapshot(prepared) {
  const out = [];
  for (const video of prepared.videos) {
    for (const part of video.parts || []) {
      const stat = fs.statSync(part.file);
      out.push({ file: part.file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out;
}

function sameSnapshot(before, after) {
  if (before.length !== after.length) {
    return `the file list changed: ${before.length} then ${after.length}`;
  }
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].file !== after[i].file) return `file ${i} is a different file`;
    if (before[i].mtimeMs !== after[i].mtimeMs) return `${path.basename(before[i].file)} was rewritten`;
    if (before[i].size !== after[i].size) return `${path.basename(before[i].file)} changed size`;
  }
  return null;
}

/** A project shaped the way the interface builds one. */
function projectWith(root, videos, overrides = {}) {
  return pipeline.normaliseProject({
    discTitle: 'Reuse Test',
    themeId: 'charcoal',
    titleAspect: '16:9',
    chaptersEnabled: false,
    output: { workDir: root, buildIso: false },
    videos,
    ...overrides,
  });
}

app.whenReady().then(async () => {
  console.log('\nBurnhouse reuse\n');

  const tools = detectTools({});
  const missing = ['ffmpeg', 'ffprobe', 'dvdauthor', 'spumux'].filter((name) => !tools[name]);

  if (missing.length) {
    skip('reuse the prepared disc', `${missing.join(', ')} not installed on this machine`);
  } else if (!fs.existsSync(FIXTURE)) {
    skip('reuse the prepared disc', `the fixture ${FIXTURE} is missing`);
  } else {
    const root = tmpdir('reuse');
    const info = await probeMod.probeVideo(tools.ffprobe, FIXTURE);

    const videos = [
      { id: 'v1', path: FIXTURE, name: 'Episode One.mp4', menuLabel: 'Episode One', duration: info.duration },
      { id: 'v2', path: FIXTURE, name: 'Episode Two.mp4', menuLabel: 'Episode Two', duration: info.duration },
    ];

    const quiet = { tools, onProgress: () => {}, onLog: () => {}, BrowserWindow };
    /** The same, but pointed at its own working folder. */
    const quietIn = (dir) => ({ ...quiet, workDir: dir });

    let first = null;
    let second = null;
    let snapFirst = null;

    await test('a first build prepares every title', async () => {
      first = await pipeline.prepare(projectWith(root, videos), quietIn(root));
      assertEqual(first.videos.length, 2, 'Both videos should be on the disc');
      assertEqual(first.reusedTitles, 0, 'Nothing can be reused on a first build');
      assertEqual(first.encodedTitles, 2, 'And both should have been encoded');
      assertEqual(first.videoTsDir.includes('VIDEO_TS'), true, 'A VIDEO_TS tree was produced');
      assert(fs.existsSync(path.join(first.videoTsDir, 'VIDEO_TS.IFO')), 'With a real IFO');
      snapFirst = snapshot(first);
      assertEqual(snapFirst.length, 2, 'One VOB per title');
    });

    await test('a second build re-encodes nothing and rewrites nothing', async () => {
      second = await pipeline.prepare(projectWith(root, videos), quietIn(root));
      assertEqual(second.reusedTitles, 2, 'Both titles should have been reused');
      assertEqual(second.encodedTitles, 0, 'And nothing should have been encoded');
      const difference = sameSnapshot(snapFirst, snapshot(second));
      assertEqual(difference, null, `The title files must be untouched: ${difference}`);
    });

    await test('changing the disc name and the slides does not touch the films', async () => {
      const renamed = projectWith(root, videos, {
        discTitle: 'A Different Name',
        deck: {
          discTitle: 'A Different Name',
          themeId: 'library',
          slides: [
            {
              id: 'menu',
              role: 'menu',
              title: 'A Different Name',
              elements: [{ id: 't', kind: 'text', text: 'Now with a subtitle', x: 40, y: 40, width: 400 }],
            },
          ],
        },
      });

      const after = await pipeline.prepare(renamed, quietIn(root));
      assertEqual(after.reusedTitles, 2, 'A renamed disc with new slides is still the same two films');
      assertEqual(after.encodedTitles, 0, 'So nothing should have been re-encoded');
      const difference = sameSnapshot(snapFirst, snapshot(after));
      assertEqual(difference, null, `The title files must be untouched: ${difference}`);
      assertEqual(after.volumeLabel !== first.volumeLabel, true, 'But the disc really did change its name');
    });

    await test('changing one film re-encodes only that film', async () => {
      // The second entry is given a different name, which is what a different
      // file looks like to the cache: same path, different size and timestamp.
      const swapped = path.join(root, 'swapped.mp4');
      fs.copyFileSync(FIXTURE, swapped);
      fs.appendFileSync(swapped, Buffer.alloc(64, 0));

      const changed = projectWith(root, [videos[0], { ...videos[1], path: swapped }]);
      const after = await pipeline.prepare(changed, quietIn(root));

      assertEqual(after.reusedTitles, 1, 'The untouched film should have been kept');
      assertEqual(after.encodedTitles, 1, 'And only the changed one prepared again');

      const before = snapFirst[0];
      const kept = snapshot(after)[0];
      assertEqual(kept.file, before.file, 'The kept title is the same file');
      assertEqual(kept.mtimeMs, before.mtimeMs, 'And it was not rewritten');
    });

    await test('forcing a rebuild prepares everything again', async () => {
      const after = await pipeline.prepare(projectWith(root, videos), { ...quietIn(root), force: true });
      assertEqual(after.reusedTitles, 0, 'Nothing may be reused when a rebuild is forced');
      assertEqual(after.encodedTitles, 2, 'Both titles should have been prepared again');
    });

    await test('a source that is already a DVD title is copied, not encoded', async () => {
      /*
        The VOB the build just produced is, by definition, a legal DVD title. Put
        it back in as the source and the pipeline should recognise that and copy
        it — which is the difference between seconds and the length of the film.

        Its own working folder, because a title folder is cleared before it is
        written and this source lives in one.
      */
      const copyRoot = tmpdir('reuse-copy');
      const prepared = await pipeline.prepare(
        projectWith(copyRoot, [
          { id: 'v1', path: snapFirst[0].file, name: 'From a DVD.vob', duration: info.duration },
        ]),
        quietIn(copyRoot)
      );

      assertEqual(prepared.copiedTitles, 1, 'It should have been recognised as already DVD video');
      assertEqual(prepared.encodedTitles, 0, 'So the encoder should not have been involved');
      assertEqual(prepared.reusedTitles, 0, 'And it was prepared, not reused');
      assert(fs.existsSync(path.join(prepared.videoTsDir, 'VIDEO_TS.IFO')), 'And still authored a disc');
    });
  }

  console.log('');
  if (failed) {
    console.log(`${failed} of ${passed + failed} checks failed.`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    app.exit(1);
  } else {
    console.log(`All ${passed} checks passed.${skipped ? ` (${skipped} skipped)` : ''}`);
    app.exit(0);
  }
});
