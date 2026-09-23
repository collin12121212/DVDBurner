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

  // ------------------------------------------- dropping a picture on a slide ---
  console.log('\nDropping a picture onto a slide');

  // A real PNG, written where the app can read it. Dropping one is the first
  // thing anybody tries, and it used to answer "Some files were not videos".
  const picturePath = path.join(sandbox, 'cover.png');
  fs.writeFileSync(
    picturePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
  );

  await js(`window.__burnhouseTest.createNewProject('Pictures', 'charcoal')`);
  await settle(700);

  const beforeDrop = await js(`window.__burnhouseTest.getState()`);
  const videosBefore = beforeDrop.videos.length;

  await js(`window.__burnhouseTest.importPathsOntoSlide([${JSON.stringify(picturePath)}])`);
  await settle(900);

  const afterDrop = await js(`window.__burnhouseTest.getState()`);
  const activeAfter = afterDrop.slides.find((s) => s.id === afterDrop.activeSlideId) || { elements: [] };
  const pictures = activeAfter.elements.filter((e) => e.kind === 'image');

  record(pictures.length === 1, 'a dropped picture becomes a picture on the slide', `${pictures.length} pictures`);
  record(
    pictures[0] && pictures[0].hasPoster,
    'and the picture was actually read, not left empty'
  );
  record(
    pictures[0] && pictures[0].width === 260 && pictures[0].height === 190,
    'at the same size the "Add a picture" button gives it',
    pictures[0] ? `${pictures[0].width}x${pictures[0].height}` : 'none'
  );
  record(
    afterDrop.videos.length === videosBefore,
    'a picture is not mistaken for a video',
    `${videosBefore} then ${afterDrop.videos.length}`
  );

  const dropNotice = await js(`window.__burnhouseTest.banner()`);
  record(
    !dropNotice || !/not videos/i.test(dropNotice.title || ''),
    'and it does not complain that the file was not a video',
    dropNotice ? dropNotice.title : 'no notice'
  );

  // A second picture in the same drop must not hide under the first.
  await js(
    `window.__burnhouseTest.importPathsOntoSlide([${JSON.stringify(picturePath)}, ${JSON.stringify(picturePath)}])`
  );
  await settle(900);

  const stacked = await js(`window.__burnhouseTest.getState()`);
  const stackedActive = stacked.slides.find((s) => s.id === stacked.activeSlideId) || { elements: [] };
  const stackedPictures = stackedActive.elements.filter((e) => e.kind === 'image');
  // A drop of several must not stack them all in one place. The first one keeps
  // the position the button would give it; the rest are staggered off it, so what
  // she dropped is what she can see and drag.
  const fromTheSecondDrop = stackedPictures.slice(pictures.length);
  record(
    fromTheSecondDrop.length === 2,
    'dropping two more adds two more pictures',
    `${stackedPictures.length} pictures in total`
  );
  record(
    new Set(fromTheSecondDrop.map((p) => `${p.x},${p.y}`)).size === 2,
    'and the two from one drop are staggered rather than exactly on top of each other',
    fromTheSecondDrop.map((p) => `${p.x},${p.y}`).join(' / ')
  );
  record(
    fromTheSecondDrop[0] && fromTheSecondDrop[0].x === 120 && fromTheSecondDrop[0].y === 140,
    'the first of a drop lands exactly where the button would put it',
    fromTheSecondDrop[0] ? `${fromTheSecondDrop[0].x},${fromTheSecondDrop[0].y}` : 'none'
  );

  // ------------------------------------------ dragging a picture too large ---
  console.log('\nDragging a picture that is bigger than the safe area');

  const pinnedLeft = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: -9999, y: 0, width: 900, height: 600 })`
  );
  const pinnedRight = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: 9999, y: 0, width: 900, height: 600 })`
  );

  record(
    pinnedLeft.x < pinnedRight.x,
    'a picture wider than the safe area moves when it is dragged',
    `x ${pinnedLeft.x} then ${pinnedRight.x}`
  );
  record(
    pinnedLeft.width === 900 && pinnedRight.width === 900,
    'and is not shrunk to fit while being moved',
    `${pinnedLeft.width} then ${pinnedRight.width}`
  );

  const smallPicture = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: -9999, y: -9999, width: 260, height: 190 })`
  );
  record(
    smallPicture.x === 40 && smallPicture.y === 40,
    'while a picture that fits is still held inside the guide',
    `${smallPicture.x},${smallPicture.y}`
  );

  /*
    And the real gesture, with real pointer events.

    The checks above prove the rule is right; this proves the drag actually uses
    it, which is the part that was reported. A picture scaled past the safe area
    used to be pinned wherever it landed and every drag snapped it back, so what
    matters is that the position changes by the amount the pointer moved.
  */
  await js(`window.__burnhouseTest.createNewProject('Dragging', 'charcoal')`);
  await settle(700);

  // Placed in its own round trip, and given a moment: the layout the drag
  // hit-tests against is fetched asynchronously, and a drag before it lands
  // finds nothing under the pointer and does nothing at all.
  await js(`window.__burnhouseTest.addElement('image', { width: 900, height: 600 })`);
  await settle(900);

  const dragResult = await js(`(() => {
    const canvas = document.getElementById('slideCanvas');
    const rect = canvas.getBoundingClientRect();
    const toClient = (x, y) => ({
      clientX: rect.left + (x / 720) * rect.width,
      clientY: rect.top + (y / 480) * rect.height,
    });
    const boxOf = () => {
      const s = window.__burnhouseTest.getState();
      const slide = s.slides.find((sl) => sl.id === s.activeSlideId);
      const img = slide.elements.find((e) => e.kind === 'image');
      return img ? { x: img.x, y: img.y, width: img.width, height: img.height } : null;
    };

    const before = boxOf();
    const from = toClient(200, 200);
    const to = toClient(100, 200);
    const pointer = (type, at, extra) => new PointerEvent(type, {
      bubbles: true, pointerId: 1, isPrimary: true, ...at, ...extra,
    });

    canvas.dispatchEvent(pointer('pointerdown', from, { button: 0, buttons: 1 }));
    document.dispatchEvent(pointer('pointermove', to, { buttons: 1 }));
    document.dispatchEvent(pointer('pointerup', to, { button: 0 }));

    return { before, after: boxOf() };
  })()`);
  await settle(400);

  record(
    dragResult.after && dragResult.before && dragResult.after.x !== dragResult.before.x,
    'dragging a picture wider than the safe area moves it',
    `x ${dragResult.before.x} then ${dragResult.after.x}`
  );
  record(
    dragResult.after && Math.abs(dragResult.after.x - (dragResult.before.x - 100)) <= 2,
    'and it follows the pointer rather than snapping to a limit',
    `moved ${dragResult.after ? dragResult.after.x - dragResult.before.x : '?'}`
  );
  record(
    dragResult.after && dragResult.after.width === 900,
    'without being shrunk while it is moved',
    dragResult.after ? String(dragResult.after.width) : '?'
  );

  // ------------------------------- a picture that goes to another slide ---
  console.log('\nMaking a picture clickable');

  await js(`window.__burnhouseTest.createNewProject('Linked', 'charcoal')`);
  await settle(700);

  const linkSetup = await js(`(async () => {
    const swatch = document.createElement('canvas');
    swatch.width = 272; swatch.height = 200;
    const c = swatch.getContext('2d');
    c.fillStyle = '#3f6d8f';
    c.fillRect(0, 0, 272, 200);
    const src = swatch.toDataURL('image/png');

    const state = window.__burnhouseTest.getState();
    const firstId = state.slides[0].id;
    const secondId = state.slides[1] ? state.slides[1].id : state.slides[0].id;

    // A picture that does something, and one that does not.
    const linked = window.__burnhouseTest.addElement('image', {
      src, x: 40, y: 60, width: 272, height: 200, targetSlideId: secondId,
    });
    const plain = window.__burnhouseTest.addElement('image', {
      src, x: 380, y: 60, width: 272, height: 200,
    });
    // And something on the second slide, so it is a page worth going to.
    window.__burnhouseTest.goToSlide(secondId);
    window.__burnhouseTest.addElement('button', { label: 'Back', targetSlideId: firstId });

    // Back to the first slide with the linked picture selected, which is the
    // state the inspector checks below are about.
    window.__burnhouseTest.goToSlide(firstId);
    window.__burnhouseTest.selectElement(linked.id);

    return { firstId, secondId, linkedId: linked.id, plainId: plain.id };
  })()`);
  await settle(1200);

  record(
    Boolean(linkSetup.linkedId) && Boolean(linkSetup.plainId),
    'two pictures were placed',
    `${linkSetup.linkedId} / ${linkSetup.plainId}`
  );

  /*
    What the disc makes of them.

    The point of the whole thing: a picture that has been given a destination is
    a button on the disc, with a rectangle the remote can land on and a command
    that goes there, and a picture without one is not.
  */
  const discs = await js(`window.__burnhouseTest.discButtons()`);
  const page1 = discs[0];
  record(discs.length === 2, 'both slides became menu pages', `${discs.length} pages`);
  record(
    page1 && page1.buttons.length === 1,
    'the first page has exactly one button: the picture that goes somewhere',
    page1 ? `${page1.buttons.length} buttons` : 'no page'
  );
  record(
    page1 && page1.buttons[0] && /jump menu/.test(page1.buttons[0].command),
    'and that button jumps to the other slide',
    page1 && page1.buttons[0] ? page1.buttons[0].command : 'none'
  );
  record(
    page1 && page1.buttons[0] && page1.buttons[0].x0 === 40 && page1.buttons[0].y0 === 60,
    'with the picture\u2019s own rectangle, not a box of its own',
    page1 && page1.buttons[0] ? `${page1.buttons[0].x0},${page1.buttons[0].y0}` : 'none'
  );

  // The inspector offers the choice, naming the "no destination" case rather
  // than leaving it as an unlabelled prompt she has to interpret.
  const choices = await js(`(() => {
    const row = [...document.querySelectorAll('#inspector .prop-row')]
      .find((r) => r.dataset.prop === 'gotoslide');
    if (!row) return null;
    const select = row.querySelector('select');
    return {
      label: row.querySelector('.prop-name').textContent,
      value: select.value,
      options: [...select.options].map((o) => o.textContent),
    };
  })()`);
  record(choices !== null, 'the picture inspector has a "goes to" row');
  record(
    choices && choices.label === 'Goes to',
    'labelled in words rather than as an identifier',
    choices ? choices.label : 'no row'
  );
  record(
    choices && choices.value === linkSetup.secondId,
    'showing the slide it was pointed at',
    choices ? choices.value : 'no row'
  );
  record(
    choices && choices.options.some((o) => /none/i.test(o)),
    'and offering doing nothing by name',
    choices ? choices.options.join(' / ') : 'no row'
  );

  /*
    Turning it off must take the button away again. Asked about the picture's own
    slide rather than the disc as a whole: the picture is the only pressable thing
    on it, so with the destination gone that slide stops being a page — and the
    other slide's button, which points at it, then leads nowhere and goes too.
    That cascade is the numbering settling correctly, not a fault.
  */
  const unlinked = await js(`(async () => {
    const first = ${JSON.stringify(linkSetup.firstId)};
    const onFirst = async () =>
      (await window.__burnhouseTest.discButtons()).filter((p) => p.slideId === first).length;

    const before = await onFirst();
    window.__burnhouseTest.setImageTarget(${JSON.stringify(linkSetup.linkedId)}, null);
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: await onFirst() };
  })()`);
  await settle(400);

  record(
    unlinked.before === 1 && unlinked.after === 0,
    'setting it back to None takes the picture off the remote again',
    `its slide was a page ${unlinked.before} time, then ${unlinked.after}`
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
