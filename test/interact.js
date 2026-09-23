'use strict';

/**
 * Focused tests for the editing gestures and the DVD simulator.
 *
 * Everything here was added together, so it is tested together and separately
 * from test/smoke.js — the point is that a change to the right-click menu, the
 * resize handles or the simulator can be checked in a few seconds without
 * re-running the whole application suite.
 *
 * Run with:  npm run test:interact
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-interact-'));
app.setPath('userData', sandbox);
fs.writeFileSync(
  path.join(sandbox, 'settings.json'),
  JSON.stringify({ version: 1, testHooks: true, workDir: path.join(sandbox, 'work') }, null, 2)
);

require('../src/main/main.js');

let passed = 0;
const failures = [];

function record(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two short clips, so there is something on the disc to navigate to. */
function makeFixtures() {
  const dir = path.join(sandbox, 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = process.env.BURNHOUSE_FFMPEG || 'ffmpeg';
  const made = [];
  const specs = [
    { name: 'one.mp4', text: 'One' },
    { name: 'two.mp4', text: 'Two' },
  ];
  for (const spec of specs) {
    const target = path.join(dir, spec.name);
    const result = spawnSync(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=2`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', target],
      { encoding: 'utf8', windowsHide: true }
    );
    if (result.status === 0 && fs.existsSync(target)) made.push(target);
  }
  return made;
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error('\nInteract tests failed:');
    console.error((err && err.stack) || String(err));
    app.exit(1);
  }
});

async function run() {
  await settle(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('No window was created.');
  win.setSize(1360, 880);
  await settle(1200);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Surface renderer errors, so a failure says what broke instead of only that
  // a script "failed to execute".
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`    [renderer] ${message}`);
  });

  /*
    The empty-project simulator, checked before any videos exist.

    A slide with no buttons is not a menu page, so a fresh project has no menus
    at all. That used to leave the screen black with only an OSD badge, which
    reads as a broken preview. It must instead show the slide she designed and
    say why nothing can be chosen.
  */
  console.log('\nSimulator with an empty project');

  await js('window.__burnhouseTest.openSimulator({})');
  await settle(1600);

  const emptyState = await js('window.__burnhouseTest.simulatorState()');
  record(emptyState.open === true, 'the simulator opens on a project with no videos');
  record(emptyState.menus === 0, 'a project with no buttons has no menu pages', String(emptyState.menus));

  const emptyScreen = await js(
    `(() => {
       const note = document.querySelector('.sim-empty');
       const canvas = document.getElementById('simCanvas');
       if (!canvas) return { note: Boolean(note), drew: false, reason: 'no canvas' };
       const ctx = canvas.getContext('2d');
       let min = 255, max = 0;
       for (let y = 0; y < canvas.height; y += 7) {
         for (let x = 0; x < canvas.width; x += 7) {
           const d = ctx.getImageData(x, y, 1, 1).data;
           const l = (d[0] + d[1] + d[2]) / 3;
           if (l < min) min = l;
           if (l > max) max = l;
         }
       }
       return { note: Boolean(note), drew: max - min > 20, spread: max - min };
     })()`
  );
  record(emptyScreen.note, 'it explains that there is nothing to choose yet');
  record(
    emptyScreen.drew,
    'the screen shows the designed slide instead of staying black',
    `luminance spread ${emptyScreen.spread}`
  );

  await js('window.__burnhouseTest.closeSimulator()');
  await settle(400);
  /*
    Opening the player moves to the Testing step, and closing it does not move
    back — that is what Escape is for in the interface. The editor checks below
    need the Slides step, so go there explicitly.
  */
  await js(`window.__burnhouseTest.goToStep('slides')`);
  await settle(1200);

  // Everything below needs real clips on the disc.
  const fixtures = makeFixtures();
  if (!fixtures.length) {
    console.log('\n  SKIP the rest — ffmpeg is not available to make test clips');
    finish();
    return;
  }

  await js(`window.__burnhouseTest.addVideos(${JSON.stringify(fixtures)})`);
  await settle(3500);

  /*
    Put a film on a slide.

    Adding videos no longer fills the menu with buttons — the menu is composed
    deliberately — so the disc gets its playable entry by placing a tile, which
    is what the simulator's "choose a button and a film starts" checks need.
  */
  const afterVideos = await js('window.__burnhouseTest.getState()');
  const contentSlide = afterVideos.slides.find((s) => s.role !== 'menu');
  const firstVideo = (afterVideos.videos || [])[0];
  record(Boolean(contentSlide && firstVideo), 'there is a slide and a video to work with');
  await js(`window.__burnhouseTest.setActiveSlide(${JSON.stringify(contentSlide.id)})`);
  await settle(600);
  await js(
    `window.__burnhouseTest.addElement('video', { videoId: ${JSON.stringify(firstVideo.id)}, label: 'Episode 1', x: 93, y: 40, width: 534, height: 356, fit: 'fill' })`
  );
  await settle(1600);

  /*
    Adding videos no longer fills the menu with buttons — the menu is composed
    deliberately — so this makes one to work with.
  */
  await js(
    `window.__burnhouseTest.addElement('button', { label: 'Episode 1', videoId: null, x: 48, y: 120, width: 400, height: 54 })`
  );
  await settle(1200);

  // ---------------------------------------------------------------- resize ---
  console.log('\nResize handles');

  const state = await js('window.__burnhouseTest.getState()');
  // Wherever it landed: the active slide is whichever was worked on last.
  const button = state.slides.flatMap((s) => s.elements).find((e) => e.kind === 'button');
  record(Boolean(button), 'a button can be placed on a slide');

  const atCorner = await js(
    `window.__burnhouseTest.handleAt(${JSON.stringify(button.id)}, ${button.x}, ${button.y})`
  );
  record(atCorner === 'nw', 'the top-left corner is grabbable', String(atCorner));

  const atCentre = await js(
    `window.__burnhouseTest.handleAt(${JSON.stringify(button.id)}, ${button.x + 200}, ${button.y + 20})`
  );
  record(atCentre === null, 'the middle of an element is not a handle', String(atCentre));

  const before = await js(
    `(() => { const e = window.__burnhouseTest.getState().slides.flatMap(s => s.elements).find(x => x.id === ${JSON.stringify(button.id)}); return { w: e.width, h: e.height, x: e.x }; })()`
  );
  const grown = await js(
    `window.__burnhouseTest.resizeElement(${JSON.stringify(button.id)}, 'e', 60, 0)`
  );
  record(grown.width > before.w, 'dragging the right edge makes it wider', `${before.w} -> ${grown.width}`);
  record(grown.x === before.x, 'the left edge stays put when dragging the right edge');

  const shrunk = await js(
    `window.__burnhouseTest.resizeElement(${JSON.stringify(button.id)}, 'e', -10000, 0)`
  );
  record(shrunk.width >= 40, 'an element cannot be dragged away to nothing', `width ${shrunk.width}`);

  /*
    A real drag, through the same pointer events a mouse produces.

    This is the regression test for "I try to drag it and it wont budge". The
    canvas draws from the layout the main process produced, not from the deck
    being edited, so a drag that only changed the deck redrew the old positions
    and nothing appeared to happen. Both the deck and the drawn layout have to
    move.
  */
  console.log('\nDragging with the mouse');

  const dragId = button.id;
  const dragged = await js(
    `(async () => {
       const canvas = document.getElementById('slideCanvas');
       if (!canvas) return { error: 'no canvas' };
       const rect = canvas.getBoundingClientRect();
       const toClient = (rx, ry) => ({
         clientX: rect.left + (rx / 720) * rect.width,
         clientY: rect.top + (ry / 480) * rect.height,
       });

       // Synthetic pointer ids are not real captures; stub them out so the
       // handler runs exactly as it does for a mouse.
       const realCapture = canvas.setPointerCapture;
       const realRelease = canvas.releasePointerCapture;
       canvas.setPointerCapture = () => {};
       canvas.releasePointerCapture = () => {};

       const before = window.__burnhouseTest.getState().slides.flatMap(s => s.elements)
         .find((e) => e.id === ${JSON.stringify(dragId)});
       const grab = toClient(before.x + before.width / 2, before.y + before.height / 2);

       canvas.dispatchEvent(new PointerEvent('pointerdown', {
         ...grab, bubbles: true, button: 0, pointerId: 1, isPrimary: true,
       }));
       await new Promise((r) => setTimeout(r, 80));

       const target = toClient(before.x + before.width / 2 + 50, before.y + before.height / 2 + 34);
       document.dispatchEvent(new PointerEvent('pointermove', {
         ...target, bubbles: true, pointerId: 1, isPrimary: true,
       }));
       await new Promise((r) => setTimeout(r, 260));

       // What the canvas is actually drawing, mid-drag.
       const drawnMidDrag = (() => {
         const s = window.__burnhouseTest.getState();
         const entry = s.layout && s.layout.slides.find((x) => x.id === s.activeSlideId);
         const el = entry && entry.elements.find((e) => e.id === ${JSON.stringify(dragId)});
         return el ? { x: el.box.x, y: el.box.y } : null;
       })();

       document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
       await new Promise((r) => setTimeout(r, 420));

       canvas.setPointerCapture = realCapture;
       canvas.releasePointerCapture = realRelease;

       const after = window.__burnhouseTest.getState();
       const deckEl = after.slides.flatMap(s => s.elements).find((e) => e.id === ${JSON.stringify(dragId)});
       const entry = after.layout && after.layout.slides.find((x) => x.id === after.activeSlideId);
       const layoutEl = entry && entry.elements.find((e) => e.id === ${JSON.stringify(dragId)});

       return {
         from: { x: before.x, y: before.y },
         deck: { x: deckEl.x, y: deckEl.y },
         drawnMidDrag,
         drawn: layoutEl ? { x: layoutEl.box.x, y: layoutEl.box.y } : null,
       };
     })()`
  );

  if (dragged.error) {
    record(false, 'a mouse drag moves the element', dragged.error);
  } else {
    record(
      dragged.deck.x !== dragged.from.x || dragged.deck.y !== dragged.from.y,
      'a mouse drag moves the element',
      `${JSON.stringify(dragged.from)} -> ${JSON.stringify(dragged.deck)}`
    );
    record(
      dragged.drawnMidDrag &&
        (dragged.drawnMidDrag.x !== dragged.from.x || dragged.drawnMidDrag.y !== dragged.from.y),
      'the canvas redraws it while the mouse is still down',
      JSON.stringify(dragged.drawnMidDrag)
    );
    record(
      dragged.drawn && Math.abs(dragged.drawn.x - dragged.deck.x) <= 2,
      'the drawn layout ends up matching the deck',
      `drawn ${JSON.stringify(dragged.drawn)} vs deck ${JSON.stringify(dragged.deck)}`
    );
  }

  // ------------------------------------------------------------ context menu ---
  console.log('\nRight-click menu');

  const labels = await js(
    `window.__burnhouseTest.openElementMenuFor(${JSON.stringify(button.id)})`
  );
  record(Array.isArray(labels) && labels.length > 0, 'right-clicking an element opens a menu');
  record(labels.some((l) => l.includes('Delete')), 'the menu can delete the element', labels.join(' | '));
  record(labels.some((l) => l.includes('Duplicate')), 'the menu can duplicate it');
  record(labels.some((l) => l.includes('front')), 'the menu can raise it');
  record(labels.some((l) => l.includes('back')), 'the menu can lower it');

  const countBefore = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  await js(`window.__burnhouseTest.clickContextItem('Duplicate')`);
  await settle(600);
  const countAfter = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  record(countAfter === countBefore + 1, 'Duplicate really adds one', `${countBefore} -> ${countAfter}`);

  await js(
    `(() => { const els = window.__burnhouseTest.getState().slides.flatMap(s => s.elements); const last = els[els.length - 1]; window.__burnhouseTest.openElementMenuFor(last.id); })()`
  );
  await js(`window.__burnhouseTest.clickContextItem('Delete')`);
  await settle(600);
  const countDeleted = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  record(countDeleted === countBefore, 'Delete really removes it', `${countAfter} -> ${countDeleted}`);

  const menuGone = await js('window.__burnhouseTest.contextMenuLabels().length');
  record(menuGone === 0, 'the menu closes once something is chosen');

  // ------------------------------------------------------------ slide menu ---
  console.log('\nRight-click menu on a slide');

  const slideState = await js('window.__burnhouseTest.getState()');
  const targetSlide = slideState.slides[slideState.slides.length - 1];

  const slideLabels = await js(
    `window.__burnhouseTest.openSlideMenuFor(${JSON.stringify(targetSlide.id)})`
  );
  record(Array.isArray(slideLabels) && slideLabels.length > 0, 'right-clicking a slide opens a menu');
  record(
    slideLabels.some((l) => l.includes('Delete')),
    'the slide menu can delete the slide',
    (slideLabels || []).join(' | ')
  );
  record(slideLabels.some((l) => l.includes('Duplicate')), 'the slide menu can duplicate it');
  record(slideLabels.some((l) => l.includes('Move up')), 'the slide menu can move it up');
  record(slideLabels.some((l) => l.includes('Move down')), 'the slide menu can move it down');
  await js('window.__burnhouseTest.closeElementMenu()');

  /*
    Moving a slide really changes the order.

    This is the check that catches the two functions that were briefly both
    called `moveSlide`: a later declaration wins, so the toolbar's move buttons
    silently did nothing while dragging still worked.
  */
  const beforeOrder = (await js('window.__burnhouseTest.getState()')).slides.map((s) => s.id);
  const movedDown = await js(
    `window.__burnhouseTest.moveSlideBy(${JSON.stringify(beforeOrder[0])}, 1)`
  );
  record(
    movedDown[0] === beforeOrder[1] && movedDown[1] === beforeOrder[0],
    'moving a slide down swaps it with the next one',
    `${beforeOrder.slice(0, 2).join(',')} -> ${movedDown.slice(0, 2).join(',')}`
  );
  const movedBack = await js(
    `window.__burnhouseTest.moveSlideBy(${JSON.stringify(beforeOrder[0])}, -1)`
  );
  record(movedBack.join(',') === beforeOrder.join(','), 'and moving it up puts it back');

  // Deleting, on a deck that can spare a slide.
  const addedSlide = await js(`window.__burnhouseTest.addSlide({ title: 'Doomed' })`);
  await settle(900);
  const afterAdd = (await js('window.__burnhouseTest.getState()')).slides.map((s) => s.id);
  const afterDelete = await js(
    `window.__burnhouseTest.deleteSlide(${JSON.stringify(addedSlide.id)})`
  );
  record(
    afterDelete.length === afterAdd.length - 1 && !afterDelete.includes(addedSlide.id),
    'a slide can be deleted',
    `${afterAdd.length} -> ${afterDelete.length}`
  );

  // ------------------------------------------------------------- simulator ---
  console.log('\nDVD player simulator');

  await js('window.__burnhouseTest.openSimulator({})');
  await settle(1800);

  let simState = await js('window.__burnhouseTest.simulatorState()');
  record(simState.open === true, 'the simulator opens');
  record(simState.domain === 'menu', 'a disc starts on its menu', simState.domain);
  record(simState.page === 1, 'starting on the first menu page', String(simState.page));
  record(simState.titles === 2, 'both films are on the disc', String(simState.titles));
  record(
    simState.focusLabel && simState.focusLabel.length > 0,
    'a button is highlighted to begin with',
    String(simState.focusLabel)
  );
  record(
    simState.focusRect && simState.focusRect.x1 > simState.focusRect.x0,
    'the highlight has a real rectangle from the disc',
    JSON.stringify(simState.focusRect)
  );

  const firstFocus = simState.focus;
  const moves = simState.moves;
  record(Boolean(moves), 'the disc reports where each arrow key goes', JSON.stringify(moves));

  if (moves && moves.down !== firstFocus) {
    const afterDown = await js(`window.__burnhouseTest.simulateArrow('down')`);
    record(afterDown.focus === moves.down, 'the down key moves where the disc says', `${firstFocus} -> ${afterDown.focus}`);
    const afterUp = await js(`window.__burnhouseTest.simulateArrow('up')`);
    record(afterUp.focus === firstFocus, 'and up comes back', String(afterUp.focus));
  } else {
    record(true, 'the down key moves where the disc says (only one button)');
    record(true, 'and up comes back (only one button)');
  }

  // Choosing a button must play a film, and the disc's own post-command must
  // bring the menu back when it ends.
  const chosen = await js(`window.__burnhouseTest.simulateEnter()`);
  await settle(900);
  const playing = await js('window.__burnhouseTest.simulatorState()');
  record(playing.domain === 'title', 'choosing a button starts a film', playing.domain);
  record(playing.title >= 1, 'on a real title number', String(playing.title));
  record(
    chosen.command && chosen.command.startsWith('jump title'),
    'the simulator ran the disc command',
    String(chosen.command)
  );

  const backToMenu = await js(`window.__burnhouseTest.simulateMenuKey()`);
  record(backToMenu.domain === 'menu', 'the Menu key returns to the menu', backToMenu.domain);
  record(backToMenu.page === backToMenu.rootPage, 'and to the disc root page', String(backToMenu.page));

  /*
    The chosen film must actually play, and must keep playing across a redraw.

    Every render used to rebuild the whole overlay, which discarded the <video>
    element that had just been given a source and told to play — so choosing a
    film produced a black screen. Both halves are checked here: that the element
    has a source and is running, and that it is still the same element (and still
    running) after a redraw.
  */
  console.log('\nPlaying a film');

  await js('window.__burnhouseTest.openSimulator({ startTitleVideoId: "__none__" })');
  await settle(700);
  await js(`window.__burnhouseTest.simulateEnter()`);
  await settle(1600);

  const playingState = await js('window.__burnhouseTest.simulatorState()');
  record(playingState.domain === 'title', 'choosing a button opens a film', playingState.domain);

  const videoBefore = await js('window.__burnhouseTest.simulatorVideo()');
  record(Boolean(videoBefore), 'there is a video element to play into');
  if (videoBefore) {
    record(Boolean(videoBefore.src), 'the film element was given a source', String(videoBefore.src).slice(0, 48));
    record(videoBefore.error === null, 'the film did not fail to load', `error code ${videoBefore.error}`);
    record(
      videoBefore.readyState >= 2,
      'the film has decoded frames to show',
      `readyState ${videoBefore.readyState}`
    );
    record(!videoBefore.paused, 'the film is playing without another press');
    record(videoBefore.time > 0, 'the film is actually advancing', `t=${videoBefore.time.toFixed(2)}s`);
  }

  // Tag the element, force a redraw, and check the same element is still there
  // and still playing.
  await js(`window.__burnhouseTest.markSimulatorVideo('keep-me')`);
  await js('window.__burnhouseTest.redrawSimulator()');
  await settle(500);
  const videoAfter = await js('window.__burnhouseTest.simulatorVideo()');
  record(
    videoAfter && videoAfter.marker === 'keep-me',
    'a redraw does not replace the film element'
  );
  record(
    videoAfter && videoAfter.time > 0,
    'the film is still playing after a redraw',
    videoAfter ? `t=${videoAfter.time.toFixed(2)}s` : 'no video'
  );

  // Back to the menu, which both proves a film can be left and puts the
  // highlight back for the position checks that follow.
  await js('window.__burnhouseTest.simulateMenuKey()');
  await settle(600);
  const backFromFilm = await js('window.__burnhouseTest.simulatorState()');
  record(backFromFilm.domain === 'menu', 'the Menu key brings the menu back from a film');
  const videoStopped = await js('window.__burnhouseTest.simulatorVideo()');
  record(
    !videoStopped || videoStopped.paused,
    'leaving a film stops it rather than playing on invisibly'
  );

  // The highlight must sit exactly where the disc's button rectangle is.
  const highlightBox = await js(
    `(() => {
       const c = document.getElementById('simCanvas');
       const h = document.getElementById('simHighlight');
       if (!c || !h) return null;
       const screen = c.getBoundingClientRect();
       const box = h.getBoundingClientRect();
       return {
         left: (box.left - screen.left) / screen.width,
         top: (box.top - screen.top) / screen.height,
         w: box.width / screen.width,
         h: box.height / screen.height,
       };
     })()`
  );
  const expected = await js('window.__burnhouseTest.simulatorState()');
  if (highlightBox && expected.focusRect) {
    const wantLeft = expected.focusRect.x0 / 720;
    const wantTop = expected.focusRect.y0 / 480;
    record(
      Math.abs(highlightBox.left - wantLeft) < 0.02,
      'the highlight is where the disc puts it, horizontally',
      `${highlightBox.left.toFixed(3)} vs ${wantLeft.toFixed(3)}`
    );
    record(
      Math.abs(highlightBox.top - wantTop) < 0.02,
      'the highlight is where the disc puts it, vertically',
      `${highlightBox.top.toFixed(3)} vs ${wantTop.toFixed(3)}`
    );
  } else {
    record(false, 'the highlight is where the disc puts it', 'no highlight or rectangle found');
  }

  await js('window.__burnhouseTest.closeSimulator()');
  await settle(400);
  const closed = await js('window.__burnhouseTest.simulatorState()');
  record(closed.open === false, 'the simulator closes');

  // -------------------------------------------------------- the burn panel ---
  console.log('\nThe burn button');

  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(2200);

  const burn = await js(`(() => {
    const button = document.getElementById('btnBurn');
    if (!button) return { present: false };
    const style = getComputedStyle(button);
    const box = button.getBoundingClientRect();
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => /Write to a blank disc/.test(p.textContent));
    return {
      present: true,
      disabled: button.disabled,
      className: button.className,
      label: button.textContent.trim(),
      // Round: the radius is half the shorter side.
      radius: parseFloat(style.borderTopLeftRadius),
      width: box.width,
      height: box.height,
      filter: style.filter,
      // The notice inside the panel, which the page-level notice used to delete.
      panelNotices: panel ? panel.querySelectorAll('.banner').length : -1,
      reason: (panel && panel.querySelector('.burn-blocked'))
        ? panel.querySelector('.burn-blocked').textContent
        : null,
    };
  })()`);

  record(burn.present, 'the burn button is on the page at all times');
  record(
    burn.className && burn.className.includes('btn-burn'),
    'the burn button uses the round style',
    String(burn.className)
  );
  record(
    // Half the side, with a couple of pixels of slack: a percentage radius
    // resolves against the box in a way that does not land exactly on half.
    burn.radius >= Math.min(burn.width, burn.height) / 2 - 4,
    'the burn button is round',
    `radius ${burn.radius} on a ${Math.round(burn.width)}x${Math.round(burn.height)} button`
  );
  record(
    Math.abs(burn.width - burn.height) < 1,
    'and circular rather than oval',
    `${Math.round(burn.width)}x${Math.round(burn.height)}`
  );
  record(!burn.disabled || Boolean(burn.reason), 'when it cannot be pressed, it says why', String(burn.reason));
  record(
    burn.panelNotices >= 1,
    'the notice inside the burn panel survives a render',
    `${burn.panelNotices} notices`
  );

  // --------------------------------------------- one folder per project ---
  //
  // The prepared disc is looked up by project, so the two things that decide
  // whether that works are checked together: that the interface tells the main
  // process which project is open, and that it asks again when a different one
  // is opened. The second was wrong — the answer was fetched once per session
  // and reused, so a second project inherited the first one's disc.
  console.log('\nEach project its own prepared disc');

  const work = path.join(sandbox, 'work');

  // The layout an older version wrote: a single build at the top of the working
  // folder, because there was only ever one.
  fs.mkdirSync(path.join(work, 'titles', 'title_1'), { recursive: true });
  fs.mkdirSync(path.join(work, 'author', 'VIDEO_TS'), { recursive: true });
  fs.writeFileSync(path.join(work, 'titles', 'title_1', 'VTS_01_1.VOB'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(work, 'author', 'VIDEO_TS', 'VIDEO_TS.IFO'), 'ifo');
  fs.writeFileSync(path.join(work, 'author', 'VIDEO_TS', 'VIDEO_TS.BUP'), 'bup');
  fs.writeFileSync(
    path.join(work, 'build.json'),
    JSON.stringify({ fingerprint: 'x'.repeat(64), volumeLabel: 'OLD' })
  );

  await js(`window.__burnhouseTest.createNewProject('First', 'charcoal')`);
  await settle(700);
  const firstId = await js(`window.__burnhouseTest.projectPayload().id`);
  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(1400);

  record(Boolean(firstId), 'a project tells the main process which project it is', String(firstId));
  record(
    fs.existsSync(path.join(work, firstId, 'build.json')),
    'a build left by the old shared layout is adopted into the project'
  );
  record(
    !fs.existsSync(path.join(work, 'build.json')),
    'and nothing is left at the top of the working folder pretending to be one'
  );

  await js(`window.__burnhouseTest.createNewProject('Second', 'charcoal')`);
  await settle(700);
  const secondId = await js(`window.__burnhouseTest.projectPayload().id`);
  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(1400);

  record(
    Boolean(secondId) && secondId !== firstId,
    'a second project has an identity of its own',
    String(secondId)
  );
  record(
    fs.existsSync(path.join(work, secondId)),
    'and is asked about separately, so it gets its own folder'
  );
  record(
    fs.existsSync(path.join(work, firstId, 'build.json')),
    'without disturbing the first project\u2019s prepared disc'
  );

  // ------------------------------------------------------------------ done ---
  finish();
}

function finish() {
  console.log('');
  if (failures.length) {
    console.log(`${failures.length} of ${passed + failures.length} checks failed.`);
    for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`);
  } else {
    console.log(`All ${passed} checks passed.`);
  }

  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* not important */
  }
  app.exit(failures.length ? 1 : 0);
}
