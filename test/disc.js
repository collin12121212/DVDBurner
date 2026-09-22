'use strict';

/**
 * Focused tests for the disc's navigation and menu subpicture.
 *
 * Kept separate from test/run.js on purpose: these are the fastest tests in the
 * project and they cover the part of the pipeline that decides whether the
 * remote works at all and whether the highlight is visible. They run in about a
 * second, so they can be run on every change instead of the full suite.
 *
 * Run with:  npm run test:disc
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dvdNav = require('../src/core/dvd_nav');
const dvdModel = require('../src/core/dvd_model');
const author = require('../src/core/author');
const deckModel = require('../src/core/deck');
const disc = require('../src/core/disc');

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
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${tag}-`));
}

function which(binary) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [binary], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const first = String(result.stdout || '').split(/\r?\n/).filter(Boolean)[0];
  return first || null;
}

function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------ navigation ---

section('Arrow-key navigation');

const column = [
  { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
  { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
  { name: 'btn3', x0: 48, y0: 260, x1: 348, y1: 314 },
];

const grid = [
  { name: 'b1', x0: 48, y0: 100, x1: 300, y1: 150 },
  { name: 'b2', x0: 48, y0: 170, x1: 300, y1: 220 },
  { name: 'b3', x0: 380, y0: 100, x1: 632, y1: 150 },
  { name: 'b4', x0: 380, y0: 170, x1: 632, y1: 220 },
];

test('down and up walk a single column', () => {
  const nav = dvdNav.navigationObject(column);
  assertEqual(nav.btn1.down, 'btn2', 'Down from the first leaves the page');
  assertEqual(nav.btn2.down, 'btn3', 'Down from the second');
  assertEqual(nav.btn3.up, 'btn2', 'Up from the last');
  assertEqual(nav.btn2.up, 'btn1', 'Up from the middle');
});

test('a direction with nowhere to go stays put', () => {
  const nav = dvdNav.navigationObject(column);
  // Pointing a direction at the button itself is how a disc says "do nothing".
  assertEqual(nav.btn1.left, 'btn1', 'Left on the leftmost');
  assertEqual(nav.btn1.right, 'btn1', 'Right with nothing to the right');
  assertEqual(nav.btn1.up, 'btn1', 'Up on the topmost');
  assertEqual(nav.btn3.down, 'btn3', 'Down on the bottom-most');
});

test('left and right cross between two columns', () => {
  const nav = dvdNav.navigationObject(grid);
  assertEqual(nav.b1.right, 'b3', 'Right moves across, not down');
  assertEqual(nav.b2.right, 'b4', 'Right from the second row');
  assertEqual(nav.b3.left, 'b1', 'Left comes back across');
  assertEqual(nav.b1.down, 'b2', 'Down stays in its own column');
});

test('every button has all four directions defined', () => {
  for (const buttons of [column, grid]) {
    const nav = dvdNav.navigationObject(buttons);
    for (const button of buttons) {
      const entry = nav[button.name];
      assert(entry, `${button.name} has no entry`);
      for (const direction of ['up', 'down', 'left', 'right']) {
        assert(
          typeof entry[direction] === 'string' && entry[direction],
          `${button.name}.${direction} is not a button name`
        );
      }
    }
  }
});

test('a single button points every direction at itself', () => {
  const nav = dvdNav.navigationObject([column[0]]);
  assertEqual(nav.btn1.up, 'btn1', 'Up');
  assertEqual(nav.btn1.down, 'btn1', 'Down');
  assertEqual(nav.btn1.left, 'btn1', 'Left');
  assertEqual(nav.btn1.right, 'btn1', 'Right');
});

// --------------------------------------------------------- spumux control ---

section('spumux control file');

const sampleButtons = [
  { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
  { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
];

test('all buttons live inside one spu element', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
  });
  const spuOpens = (xml.match(/<spu\b/g) || []).length;
  const spuCloses = (xml.match(/<\/spu>/g) || []).length;
  assertEqual(spuOpens, 1, 'There must be exactly one <spu>');
  assertEqual(spuCloses, 1, 'And it must be closed');
  assertEqual((xml.match(/<button\b/g) || []).length, 2, 'Both buttons are present');
});

test('geometry is on the button, never on the spu', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
  });
  const spuTag = /<spu\b[^>]*>/.exec(xml)[0];
  for (const attr of ['x0', 'y0', 'x1', 'y1']) {
    assert(
      !new RegExp(`${attr}=`).test(spuTag),
      `spumux rejects ${attr} on <spu> and aborts the whole build`
    );
  }
  const buttonTag = /<button\b[^>]*>/.exec(xml)[0];
  for (const attr of ['x0', 'y0', 'x1', 'y1']) {
    assert(new RegExp(`${attr}="`).test(buttonTag), `${attr} must be on <button>`);
  }
});

test('only attributes spumux accepts are emitted', () => {
  // The exact allow-list from spumux's own parser table.
  const allowed = {
    spu: ['image', 'highlight', 'select', 'start', 'end', 'transparent',
      'autooutline', 'outlinewidth', 'autoorder', 'force', 'xoffset', 'yoffset'],
    button: ['name', 'up', 'down', 'left', 'right', 'x0', 'y0', 'x1', 'y1'],
    stream: [],
    subpictures: ['format'],
  };
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
    highlightPath: 'highlight_1.png',
    selectPath: 'select_1.png',
  });

  for (const tag of ['spu', 'button']) {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
    let match;
    while ((match = re.exec(xml))) {
      for (const attr of match[1].matchAll(/([a-zA-Z0-9_-]+)="/g)) {
        assert(
          allowed[tag].includes(attr[1]),
          `spumux does not accept "${attr[1]}" on <${tag}>`
        );
      }
    }
  }
});

test('navigation is written into the button tags', () => {
  const buttons = [
    { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
    { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
  ];
  const xml = author.buildSpumuxXml({
    buttons,
    navigation: dvdNav.navigationObject(buttons),
  });
  assert(/down="btn2"/.test(xml), 'The first button must point down at the second');
  assert(/up="btn1"/.test(xml), 'The second must point up at the first');
});

test('highlight and select are file names, not colours', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
    highlightPath: 'highlight_1.png',
    selectPath: 'select_1.png',
  });
  assert(/highlight="highlight_1\.png"/.test(xml), 'highlight must be a path');
  assert(/select="select_1\.png"/.test(xml), 'select must be a path');
  assert(!/#/.test(xml), 'a colour where spumux expects a file makes it look for a file named "#e0a34a"');
});

test('button rectangles are even, as the subpicture format needs', () => {
  const odd = [{ name: 'btn1', x0: 49, y0: 101, x1: 349, y1: 155 }];
  const xml = author.buildSpumuxXml({ buttons: odd });
  assert(/x0="50"/.test(xml), `Expected x0 to round up to even, got ${xml}`);
  assert(/y0="102"/.test(xml), 'y0 must be even');
});

// ------------------------------------------------- highlight image on disk ---

section('Highlight picture');

const ffmpeg = which('ffmpeg');

if (!ffmpeg) {
  console.log('  SKIP the highlight picture is generated — ffmpeg is not installed');
} else {
  test('the highlight picture is transparent except over the buttons', () => {
    /*
      This is the layer that shows which button the remote is on. If the alpha
      channel comes out at zero the whole picture is invisible and the menu has
      no highlight at all on a television — which is exactly what happens if
      drawbox is used with an alpha colour instead of alphamerge.
    */
    const dir = tmpdir('highlight');
    const out = path.join(dir, 'highlight.png');
    const args = author.buildHighlightImageArgs({
      outputPng: out,
      boxes: [
        { x0: 48, y0: 100, x1: 348, y1: 154 },
        { x0: 48, y0: 180, x1: 348, y1: 234 },
      ],
      color: '#e0a34a',
      opacity: 84,
    });
    assert(args, 'Arguments were produced');

    const run = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
    assertEqual(run.status, 0, `ffmpeg failed: ${run.stderr}`);
    assert(fs.existsSync(out), 'The picture was written');

    const raw = path.join(dir, 'highlight.raw');
    const toRaw = spawnSync(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-i', out, '-pix_fmt', 'rgba', '-f', 'rawvideo', raw],
      { encoding: 'utf8', windowsHide: true }
    );
    assertEqual(toRaw.status, 0, 'Could read the picture back');

    const px = fs.readFileSync(raw);
    assertEqual(px.length, 720 * 480 * 4, 'Picture is the size of the menu');

    const at = (x, y) => {
      const o = (y * 720 + x) * 4;
      return { r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] };
    };

    const corner = at(5, 5);
    assertEqual(corner.a, 0, 'Outside the buttons must be fully transparent');

    const inBox = at(200, 125);
    assert(inBox.a > 40, `The highlight must be visible, alpha was ${inBox.a}`);
    assert(inBox.a < 250, `The highlight must be see-through, alpha was ${inBox.a}`);
    assert(inBox.r > inBox.b, 'The highlight carries the accent colour');

    const between = at(200, 165);
    assertEqual(between.a, 0, 'The gap between buttons stays transparent');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no buttons means no picture rather than a broken command', () => {
    assertEqual(
      author.buildHighlightImageArgs({ outputPng: 'x.png', boxes: [] }),
      null,
      'An empty filter chain is an ffmpeg error, so it must not be attempted'
    );
  });
}

// ------------------------------------------------------------- disc model ---

section('Disc model');

function slideWithVideos() {
  return {
    discTitle: 'Holiday',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1',
        title: 'Holiday',
        role: 'menu',
        themeId: 'charcoal',
        elements: [
          {
            id: 'b1', kind: 'button', label: 'Episode 1', videoId: 'v1',
            x: 48, y: 100, width: 400, height: 54,
          },
          {
            id: 'b2', kind: 'button', label: 'Episode 2', videoId: 'v2',
            x: 48, y: 180, width: 400, height: 54,
          },
          {
            id: 'b3', kind: 'button', label: 'Nowhere', targetSlideId: null,
            x: 48, y: 260, width: 400, height: 54,
          },
        ],
      },
    ],
  };
}

test('a slide with buttons becomes a numbered menu page', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  assertEqual(model.menus.length, 1, 'One menu page');
  assertEqual(model.menus[0].page, 1, 'Numbered from one');
  assertEqual(model.firstPlay.type, 'menu', 'The disc starts on the menu');
  assertEqual(model.firstPlay.number, 1, 'First play is page one');
});

test('buttons play the right title, in video order', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  const commands = model.menus[0].buttons.map((b) => b.command);
  assertEqual(commands[0], 'jump title 1;', 'First button plays title 1');
  assertEqual(commands[1], 'jump title 2;', 'Second button plays title 2');
});

test('a button that leads nowhere is left off the disc', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  // The third button targets nothing and plays nothing: on a disc it would be a
  // highlight that does nothing when chosen, which reads as a broken remote.
  assertEqual(model.menus[0].buttons.length, 2, 'Only the two live buttons remain');
  assert(
    !model.menus[0].buttons.some((b) => b.label === 'Nowhere'),
    'The dead button is gone'
  );
});

test('the model carries the navigation the simulator will use', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1' }, { id: 'v2' }],
  });
  const nav = model.menus[0].navigation;
  assert(nav.btn1 && nav.btn2, 'Both buttons have navigation entries');
  assertEqual(nav.btn1.down, 'btn2', 'Down from the first reaches the second');
});

test('a slide with no buttons is not a menu page', () => {
  const deck = slideWithVideos();
  deck.slides[0].elements = [
    { id: 't1', kind: 'text', text: 'Just words', x: 48, y: 100, width: 400, height: 50 },
  ];
  const model = dvdModel.buildDiscModel({ deck, videos: [] });
  assertEqual(model.menus.length, 0, 'No pages');
  assertEqual(model.firstPlay.type, 'title', 'Playback falls back to the title');
  assertEqual(model.firstPlay.number, 1, 'Numbered from one');
});

test('a button pointing at another slide jumps to that menu page', () => {
  const deck = {
    discTitle: 'Two pages',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Go', targetSlideId: 'menu-2', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
      {
        id: 'menu-2', title: 'Second', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'b1', kind: 'button', label: 'One', videoId: 'v1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });
  assertEqual(model.menus.length, 2, 'Both pages are menus');
  assertEqual(model.menus[0].buttons[0].command, 'jump menu 2;', 'The link jumps to page two');
});

test('a button pointing at a slide showing a film plays that film', () => {
  /*
    Aiming a button at a slide whose whole purpose is one video should start
    that video. Opening the page instead would make the viewer press again to
    do the only thing the page offers.
  */
  const deck = {
    discTitle: 'Play through',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Watch', targetSlideId: 'ep-1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
      {
        id: 'ep-1', title: 'Episode', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 'v1', kind: 'video', videoId: 'v1', label: 'Episode', x: 48, y: 40, width: 534, height: 356 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });

  // The episode slide carries the automatic Back/Next row, so it is a menu page
  // in its own right. That is not what the button should use, though: aiming at
  // it means "play this film".
  assertEqual(model.menus.length, 2, 'Both the menu and the episode slide have buttons');
  assertEqual(
    model.menus[0].buttons[0].command,
    'jump title 1;',
    'The button should start the film, not open the slide'
  );
  assertEqual(model.menus[0].buttons[0].action.type, 'title', 'And it is a title action');
});

test('a slide with a film and its own buttons still plays the film', () => {
  // The episode slide carries the automatic Back/Next row as well as the film,
  // and that must not change what a button aimed at it does.
  const deck = {
    discTitle: 'Play through',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Watch', targetSlideId: 'ep-1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
      {
        id: 'ep-1', title: 'Episode', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 'v1', kind: 'video', videoId: 'v1', label: 'Episode', x: 48, y: 40, width: 534, height: 356 },
        ],
      },
      {
        id: 'ep-2', title: 'Another', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 't1', kind: 'text', text: 'Words only', x: 48, y: 60, width: 400, height: 50 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });

  const first = model.menus[0].buttons[0];
  assertEqual(first.command, 'jump title 1;', 'Still plays the film');

  // The words-only slide has no film, so a button aimed at it must still open
  // the page rather than jumping somewhere unrelated.
  const pageForWords = model.menus.find((m) => m.slideId === 'ep-2');
  assert(pageForWords, 'The slide with buttons is a menu page of its own');
});

// ------------------------------------------------- the disc writer on macOS ---

section('Finding a disc writer');

/*
  `drutil list` is what macOS gives us, and every column in it can contain a
  space. Reading the fields by counting back from the end of the line got the bus
  as "Apple" and the support level as the wrong word, and then refused the drive
  because of it — so the app said no burner was attached while one sat there
  plugged in. These are the shapes that have to survive.
*/
test('a USB writer with a two-word support level is found', () => {
  const out = [
    '   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode',
    '   hp       DVDRW  DU8A6SH    DH61  USB           Apple Supported          /dev/disk5',
  ].join('\n');

  const drives = disc.parseDrutilList(out);
  assertEqual(drives.length, 1, 'one drive');
  assertEqual(drives[0].device, '/dev/disk5', 'the device node');
  assertEqual(drives[0].vendor, 'hp', 'the vendor');
  assertEqual(drives[0].bus, 'USB', 'the bus, not the first word of the support level');
  assertEqual(drives[0].rev, 'DH61', 'the revision');
  assertEqual(drives[0].supportLevel, 'Apple Supported', 'the whole support level');
  assertEqual(drives[0].writeCapable, true, 'and it can write');
});

test('a product name containing spaces stays in one piece', () => {
  const out = [
    '   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode',
    '   HL-DT-ST DVDRAM GP65NB60   PF00  USB           Apple Shipping           /dev/disk4',
  ].join('\n');

  const drives = disc.parseDrutilList(out);
  assertEqual(drives[0].product, 'DVDRAM GP65NB60', 'the product keeps its second word');
  assertEqual(drives[0].vendor, 'HL-DT-ST', 'and the vendor is not swallowed');
  assertEqual(drives[0].label, 'HL-DT-ST DVDRAM GP65NB60', 'the label reads naturally');
});

test('an unrecognised support level still counts as writable', () => {
  // Being strict here hid working burners. Only an explicit "Unsupported" is
  // taken at its word.
  const out = [
    '   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode',
    '   hp       DVDRW  DU8A6SH    DH61  USB           Vendor Specific          /dev/disk5',
    '   bogus    Not A Burner      X1    USB           Unsupported              /dev/disk9',
  ].join('\n');

  const drives = disc.parseDrutilList(out);
  assertEqual(drives.length, 2, 'both rows are parsed');
  assertEqual(drives[0].writeCapable, true, 'an unfamiliar level is not a refusal');
  assertEqual(drives[1].writeCapable, false, 'but "Unsupported" is believed');
});

test('several writers are all listed, and nothing else is', () => {
  const out = [
    '   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode',
    '   HL-DT-ST DVDRAM GP65NB60   PF00  USB           Apple Shipping           /dev/disk4',
    '   hp       DVDRW  DU8A6SH    DH61  USB           Apple Supported          /dev/disk5',
    '',
    'No media inserted',
  ].join('\n');

  assertEqual(disc.parseDrutilList(out).length, 2, 'exactly the two device rows');
});

test('output with no usable header still yields the drive', () => {
  // An unfamiliar layout must not mean "no burner", which is the failure this
  // whole section exists to prevent.
  const out = [
    'Vendor Product Rev Bus SupportLevel DeviceNode',
    'hp DVDRW_8A6SH DH61 USB Apple Supported /dev/disk5',
  ].join('\n');

  const drives = disc.parseDrutilList(out);
  assertEqual(drives.length, 1, 'the drive is still found');
  assertEqual(drives[0].device, '/dev/disk5', 'with its device node');
  assertEqual(drives[0].writeCapable, true, 'and it is usable');
});

test('empty output is no drives, not an error', () => {
  assertEqual(disc.parseDrutilList('').length, 0, 'nothing in, nothing out');
  assertEqual(disc.parseDrutilList('No drives found').length, 0, 'so is a plain message');
});

/*
  The XML form is what the app asks for, because the plain listing is a
  fixed-width table whose columns move between macOS versions and whose fields
  can each contain spaces. A real Mac reported its working USB writer in a shape
  the text parser could not read at all, and the app said no burner was attached.
*/
const DRUTIL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<array>',
  '  <dict>',
  '    <key>Vendor</key><string>hp</string>',
  '    <key>Product</key><string>DVDRW  DU8A6SH</string>',
  '    <key>Revision</key><string>DH61</string>',
  '    <key>Bus</key><string>USB</string>',
  '    <key>SupportLevel</key><string>Unsupported</string>',
  '    <key>DeviceNode</key><string>/dev/disk5</string>',
  '  </dict>',
  '</array>',
  '</plist>',
].join('\n');

test('a drive is read out of the XML listing', () => {
  const drives = disc.parseDrutilXml(DRUTIL_XML);
  assertEqual(drives.length, 1, 'one drive');
  assertEqual(drives[0].vendor, 'hp', 'the vendor');
  assertEqual(drives[0].product, 'DVDRW  DU8A6SH', 'the product, spaces and all');
  assertEqual(drives[0].rev, 'DH61', 'the revision');
  assertEqual(drives[0].bus, 'USB', 'the bus');
  assertEqual(drives[0].device, '/dev/disk5', 'the device node');
});

test('a drive macOS calls Unsupported is still offered', () => {
  // hdiutil picks the only attached writer itself when not told which to use,
  // so refusing to list the drive costs the whole feature and gains nothing.
  // The burn attempt is what decides, and it fails before writing if it must.
  const drives = disc.parseDrutilXml(DRUTIL_XML);
  assertEqual(drives[0].supportLevel, 'Unsupported', 'the level is reported');
  assertEqual(drives[0].writeCapable, true, 'but the drive is still usable');
  assertEqual(drives[0].label, 'hp DVDRW DU8A6SH', 'and it reads sensibly');
});

test('a drive with no device node is still listed', () => {
  const withoutNode = DRUTIL_XML.replace(
    '<key>DeviceNode</key><string>/dev/disk5</string>',
    ''
  );
  const drives = disc.parseDrutilXml(withoutNode);
  assertEqual(drives.length, 1, 'the drive survives');
  assertEqual(drives[0].device, '', 'with no device node');
  assert(drives[0].id, 'and some identifier to select it by');
});

test('a device node under an unexpected key is still found', () => {
  const renamed = DRUTIL_XML.replace(
    '<key>DeviceNode</key><string>/dev/disk5</string>',
    '<key>IOKitPath</key><string>IOService:/USB/disk5</string>'
  );
  const drives = disc.parseDrutilXml(renamed);
  assertEqual(drives[0].device, '/dev/disk5', 'the node is found wherever it hides');

  const bare = DRUTIL_XML.replace(
    '<key>DeviceNode</key><string>/dev/disk5</string>',
    '<key>BSDName</key><string>disk9</string>'
  );
  assertEqual(disc.parseDrutilXml(bare)[0].device, '/dev/disk9', 'and a bare name is normalised');
});

test('two drives in one XML listing are both read', () => {
  const two = DRUTIL_XML.replace(
    '</array>',
    '  <dict>\n    <key>Vendor</key><string>HL-DT-ST</string>\n' +
      '    <key>Product</key><string>DVDRAM GP65NB60</string>\n' +
      '    <key>Revision</key><string>PF00</string>\n' +
      '    <key>Bus</key><string>USB</string>\n' +
      '    <key>SupportLevel</key><string>Apple Shipping</string>\n' +
      '    <key>DeviceNode</key><string>/dev/disk4</string>\n' +
      '  </dict>\n</array>'
  );
  const drives = disc.parseDrutilXml(two);
  assertEqual(drives.length, 2, 'both drives');
  assertEqual(drives[1].label, 'HL-DT-ST DVDRAM GP65NB60', 'the second one too');
});

test('non-XML output is not mistaken for drives', () => {
  assertEqual(disc.parseDrutilXml('').length, 0, 'empty');
  assertEqual(disc.parseDrutilXml('No drives found').length, 0, 'a plain message');
  assertEqual(disc.parseDrutilXml('   Vendor   Product   Rev   Bus   SupportLevel   DeviceNode\n' +
    '   hp       DVDRW     DH61  USB   Unsupported    /dev/disk5').length, 0, 'a text table');
});

/*
  A real Mac reported its writer as one line of labelled fields rather than the
  table, in this shape. Neither of the other two parsers could read it, so the
  app said no burner was attached while DVDStyler was burning to it happily.
*/
test('the labelled listing is read, device node or not', () => {
  const line =
    '   Vendor: 1   Product: hp DVDRW DU8A6SH   Rev: DH61   Bus: USB   ' +
    'SupportLevel: Unsupported';

  const drives = disc.parseDrutilKeyValues(line);
  assertEqual(drives.length, 1, 'the drive is found');
  assertEqual(drives[0].product, 'hp DVDRW DU8A6SH', 'the product is read');
  assertEqual(drives[0].rev, 'DH61', 'the revision is read');
  assertEqual(drives[0].bus, 'USB', 'the bus is read');
  assertEqual(drives[0].supportLevel, 'Unsupported', 'the support level is read');
  assertEqual(drives[0].label, 'hp DVDRW DU8A6SH', 'and a stray numeric vendor is dropped');
});

test('a labelled drive with no device node still gets a usable id', () => {
  // The UI selects drives by id. An empty id meant the choice never stuck and
  // the Burn button stayed disabled while a working drive sat there.
  const drives = disc.parseDrutilKeyValues('Vendor: hp\nProduct: DVDRW DU8A6SH\nBus: USB');
  assertEqual(drives.length, 1, 'one drive');
  assert(drives[0].id, 'the id is not empty');
  assertEqual(drives[0].device, '', 'and there is no device node, which is allowed');
});

test('a labelled device node is used when present', () => {
  const drives = disc.parseDrutilKeyValues(
    'Vendor: hp   Product: DVDRW DU8A6SH   Bus: USB   SupportLevel: Unsupported   DeviceNode: /dev/disk5'
  );
  assertEqual(drives[0].device, '/dev/disk5', 'the node is picked up');
  assertEqual(drives[0].id, '/dev/disk5', 'and used as the id');
});

test('two labelled drives are read as two, not merged', () => {
  const drives = disc.parseDrutilKeyValues(
    'Vendor: hp   Product: DVDRW DU8A6SH   Bus: USB\n' +
      'Vendor: HL-DT-ST   Product: DVDRAM GP65NB60   Bus: USB'
  );
  assertEqual(drives.length, 2, 'both drives');
  assertEqual(drives[0].product, 'DVDRW DU8A6SH', 'the first');
  assertEqual(drives[1].product, 'DVDRAM GP65NB60', 'the second');
});

test('listDrives falls through to the labelled form', () => {
  // The whole chain: table, then labelled. Whichever shape a Mac produces, the
  // drive has to come out the other end.
  const drives = disc.parseDrutilList(
    '   Vendor: 1   Product: hp DVDRW DU8A6SH   Rev: DH61   Bus: USB   SupportLevel: Unsupported'
  );
  assertEqual(drives.length, 1, 'the table parser still finds it');
  assertEqual(drives[0].device, '', 'without a device node');
  assert(drives[0].id, 'but with an id to select it by');
});

// ------------------------------------------------------- the disc's shape ---

/**
 * A DVD player only treats a disc as DVD-Video if VIDEO_TS sits at the ROOT.
 *
 * This is not a detail that shows up in any file the authoring tools produce —
 * dvdauthor's output is identical either way. It only appears when a player
 * reads the finished disc, and what it does then is show a file browser and play
 * the VOBs as files. That is what happened: the image was built from the
 * authoring folder with the folder itself included, so the root held a directory
 * called `author` with the real VIDEO_TS buried inside it.
 *
 * So this asserts the shape of the image itself, which is the only place the
 * mistake is visible on a computer.
 */
async function checkImageRoot() {
  const discWindows = require('../src/core/disc_windows');

  const work = tmpdir('bh-iso-root');
  const authorDir = path.join(work, 'author');
  const videoTs = path.join(authorDir, 'VIDEO_TS');
  fs.mkdirSync(videoTs, { recursive: true });
  fs.mkdirSync(path.join(authorDir, 'AUDIO_TS'), { recursive: true });
  for (const name of ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.VOB', 'VTS_01_1.VOB']) {
    fs.writeFileSync(path.join(videoTs, name), Buffer.alloc(8192, 7));
  }
  // Scratch that lives in the same folder and must not reach the disc.
  fs.writeFileSync(path.join(authorDir, 'dvdauthor.xml'), '<dvdauthor/>', 'utf8');

  const outputIso = path.join(work, 'disc.iso');
  await discWindows.buildIso({ sourceDir: authorDir, outputIso, volumeLabel: 'SHAPETEST' });

  // Mount read-only to read the image's root, then unmount.
  const psPath = path.join(work, 'inspect.ps1');
  fs.writeFileSync(
    psPath,
    '\uFEFF' +
      [
        "$ErrorActionPreference = 'Stop'",
        `$img = Mount-DiskImage -ImagePath '${outputIso}' -PassThru`,
        '$vol = $img | Get-Volume',
        // Joined rather than interpolated: PowerShell reads "$letter:\\" as a
        // drive qualifier on the variable and will not parse it.
        "$root = $($vol.DriveLetter) + ':\\'",
        "Write-Output ('FS=' + $vol.FileSystem)",
        "Get-ChildItem $root -Force | ForEach-Object { Write-Output ('ENTRY=' + $_.Name) }",
        `Dismount-DiskImage -ImagePath '${outputIso}' | Out-Null`,
      ].join('\n'),
    'utf8'
  );

  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath],
    { encoding: 'utf8', windowsHide: true }
  );
  const out = String(run.stdout || '');
  const entries = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ENTRY='))
    .map((l) => l.slice('ENTRY='.length));

  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

  assert(/FS=UDF/.test(out), `The image must be UDF, got: ${out.split('\n')[0]}`);
  assert(entries.includes('VIDEO_TS'), `VIDEO_TS must be at the root, found: ${entries.join(', ')}`);
  assert(entries.includes('AUDIO_TS'), 'AUDIO_TS must be at the root');
  assertEqual(entries.includes('author'), false, 'The authoring folder itself must not be on the disc');
  assertEqual(
    entries.includes('dvdauthor.xml'),
    false,
    'Scratch files from the authoring folder must not reach the disc'
  );
}

// --------------------------------------------------------------------- go ---

(async () => {
  if (process.platform === 'win32') {
    section("The disc image's shape");
    await checkImageRoot()
      .then(() => {
        passed += 1;
        console.log('  PASS VIDEO_TS and AUDIO_TS sit at the root of the image');
      })
      .catch((err) => {
        failed += 1;
        failures.push({ name: 'disc image root', message: String((err && err.message) || err) });
        console.log('  FAIL VIDEO_TS and AUDIO_TS sit at the root of the image');
        console.log(`       ${String((err && err.message) || err)}`);
      });
  } else {
    section("The disc image's shape");
    console.log('  SKIP building a disc image — this test mounts an ISO, which needs Windows');
  }

  console.log('');
  if (failed) {
    console.log(`${failed} of ${passed + failed} checks failed.`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  } else {
    console.log(`All ${passed} checks passed.`);
  }
  void deckModel;
})();

