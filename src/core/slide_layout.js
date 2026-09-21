'use strict';

/**
 * Slide layout.
 *
 * Turns a slide description into fully-resolved geometry: wrapped text lines,
 * measured boxes, and the button regions that the DVD authoring step needs.
 *
 * This module is pure arithmetic and has no dependency on canvas or Electron,
 * because it runs in three places: the editor's live preview, the offscreen
 * renderer that produces the picture burned to the disc, and the authoring step
 * that writes the button rectangles into the DVD structure. One implementation
 * means the highlight on a real player lines up with the label she sees while
 * designing, which is the thing most likely to be subtly wrong.
 *
 * Text is wrapped here rather than at draw time so that an element's box, the
 * picture, and the clickable area all come from the same measurement.
 */

const deckModel = require('./deck');

const { RASTER, SAFE_MARGIN, MAX_BUTTONS_PER_SLIDE, getTheme, getFont, fontSizeFor } = deckModel;

/** Line spacing as a multiple of the font size. */
const LINE_HEIGHT = 1.32;
/** Padding inside a text element's own box. */
const TEXT_PADDING_X = 10;
const TEXT_PADDING_Y = 8;

/** How a button renders on the slide. */
const BUTTON_STYLES = [
  { id: 'bar', label: 'Filled bar' },
  { id: 'outline', label: 'Outline' },
  { id: 'underline', label: 'Underline' },
  { id: 'plain', label: 'Plain text' },
];

/**
 * A DVD raster is not square pixels.
 *
 * The menu is authored at 720x480 and a player stretches that to fill a
 * widescreen television — the frame is anamorphic. So a shape that should look
 * 16:9 on screen must be 3:2 in raster units, and a picture must be drawn
 * against a box measured the same way. Getting this wrong is invisible in the
 * editor and obvious on the television: a video tile ends up about 19% too
 * wide, and faces look stretched.
 *
 * These two helpers are the only place that conversion happens.
 */
const MENU_DISPLAY_ASPECT = 16 / 9;

/**
 * The name a slide's background picture travels under in the decoded-picture map.
 *
 * Reserved, because element ids are generated and will never be this.
 */
const BACKGROUND_IMAGE_KEY = '__background__';

/** How much wider the raster appears on screen than it is in pixels. */
function rasterStretch(displayAspect = MENU_DISPLAY_ASPECT) {
  const rasterAspect = RASTER.width / RASTER.height;
  return displayAspect / rasterAspect;
}

/** The raster aspect ratio that will *display* as `displayAspect`. */
function displayAspectToRaster(displayAspect, menuDisplayAspect = MENU_DISPLAY_ASPECT) {
  const stretch = rasterStretch(menuDisplayAspect);
  return stretch > 0 ? displayAspect / stretch : displayAspect;
}

/**
 * Measure a string without a canvas.
 *
 * Canvas measurement would be more exact, but it is only available in the
 * browser, and the authoring step runs in the main process without one. An
 * approximate advance width per character is close enough for wrapping and for
 * sizing a button, and — critically — it is the *same* approximation
 * everywhere, so the picture and the button agree.
 *
 * The per-character factor is tuned for Helvetica-like faces at normal weight:
 * average lowercase plus space. Wide fonts wrap slightly early, which is the
 * safe direction.
 */
const CHAR_WIDTH_FACTOR = 0.54;

function measureText(text, fontPx, fontId) {
  const font = getFont(fontId);
  // Monospace is exactly twice as predictable, and headings run slightly wide.
  let factor = CHAR_WIDTH_FACTOR;
  if (font.id === 'typewriter') factor = 0.60;
  else if (font.id === 'condensed') factor = 0.48;
  else if (font.id === 'title') factor = 0.56;
  else if (font.id === 'serif') factor = 0.53;
  return String(text || '').length * fontPx * factor;
}

/**
 * Break text into lines that fit `maxWidth`.
 *
 * Honours explicit newlines, then wraps on spaces. A single word too long for
 * the line is broken mid-word rather than allowed to overflow, because
 * overflowing a menu picture means the words are simply not on the disc.
 */
function wrapText(text, maxWidth, fontPx, fontId) {
  const value = String(text === undefined || text === null ? '' : text);
  const paragraphs = value.split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (!words.length) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, fontPx, fontId) <= maxWidth || !current) {
        // A single word longer than the line is broken by character.
        if (!current && measureText(word, fontPx, fontId) > maxWidth) {
          const pieces = breakLongWord(word, maxWidth, fontPx, fontId);
          for (let i = 0; i < pieces.length - 1; i += 1) lines.push(pieces[i]);
          current = pieces[pieces.length - 1];
        } else {
          current = candidate;
        }
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.length ? lines : [''];
}

function breakLongWord(word, maxWidth, fontPx, fontId) {
  const pieces = [];
  let current = '';
  for (const character of word) {
    const candidate = current + character;
    if (measureText(candidate, fontPx, fontId) > maxWidth && current) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** How tall a wrapped block is, in raster pixels. */
function textBlockHeight(lineCount, fontPx) {
  return Math.round(lineCount * fontPx * LINE_HEIGHT);
}

/**
 * Resolve one element's geometry into something the renderer can draw from
 * directly, with no further measurement.
 */
function resolveElement(element, theme) {
  if (element.kind === 'text') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - TEXT_PADDING_X * 2);
    const lines = wrapText(element.text, innerWidth, fontPx, element.fontId);
    const blockHeight = textBlockHeight(lines.length, fontPx);
    const boxHeight = element.autoHeight === false
      ? Math.max(blockHeight + TEXT_PADDING_Y * 2, element.height)
      : blockHeight + TEXT_PADDING_Y * 2;

    return {
      ...element,
      fontPx,
      font: getFont(element.fontId),
      lines,
      lineHeight: Math.round(fontPx * LINE_HEIGHT),
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: boxHeight,
      },
      color: theme[element.color] || theme.text,
      background: element.background === 'none' ? null : theme[element.background] || null,
    };
  }

  if (element.kind === 'button') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - 32);

    // The visible label is what a player highlights, so it must fit inside the
    // button. It is shrunk rather than wrapped: a two-line button on a
    // television is harder to read than a slightly smaller one-line button.
    let labelFontPx = fontPx;
    while (labelFontPx > 10 && measureText(element.label, labelFontPx, element.fontId) > innerWidth) {
      labelFontPx -= 1;
    }
    const labelText = element.label;

    return {
      ...element,
      fontPx: labelFontPx,
      font: getFont(element.fontId),
      labelText,
      color: theme[element.color] || theme.text,
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
    };
  }

  if (element.kind === 'image') {
    return {
      ...element,
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
    };
  }

  if (element.kind === 'video') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - 32);

    let labelFontPx = fontPx;
    while (labelFontPx > 10 && measureText(element.label, labelFontPx, element.fontId) > innerWidth) {
      labelFontPx -= 1;
    }

    const box = {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    };

    // The play mark sits centered in the video frame
    const markSize = Math.max(24, Math.min(52, Math.round(Math.min(box.width, box.height) * 0.18)));
    const captionHeight = element.showLabel
      ? Math.max(30, Math.min(50, Math.round(box.height * 0.16)))
      : 0;

    return {
      ...element,
      fontPx: labelFontPx,
      fontFamily: getFont(element.fontId),
      color: theme[element.color] || theme.text,
      box,
      captionHeight,
      // The video picture fills the full box edge-to-edge with no black bars
      imageBox: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      mark: {
        size: markSize,
        x: box.x + Math.round((box.width - markSize) / 2),
        y: box.y + Math.round((box.height - (element.showLabel ? captionHeight / 2 : 0) - markSize) / 2),
      },
    };
  }

  // frame
  return {
    ...element,
    box: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    },
    fillColor: theme[element.fill] || theme.panel,
  };
}

/**
 * The navigation row added to non-menu slides.
 *
 * A multi-page menu is useless if there is no way to move between pages, and
 * asking a non-technical user to place their own Back button would guarantee
 * some discs without one. So it is added automatically and placed where a
 * television-safe corner is.
 */
function navigationElements(slide, slides) {
  const index = slides.indexOf(slide);
  const elements = [];
  const isMenu = slide.role === 'menu';
  if (isMenu || slides.length < 2) return elements;

  const navWidth = 110;
  const navHeight = 32;
  const y = RASTER.height - SAFE_MARGIN - navHeight; // 480 - 40 - 32 = 408

  if (index > 0) {
    const isPrevMenu = slides[index - 1].role === 'menu' || index === 1;
    elements.push({
      ...deckModel.makeButtonElement({
        label: isPrevMenu ? '\u2039  Menu' : '\u2039  Back',
        fontSize: 'small',
        buttonStyle: 'plain',
        align: 'left',
        x: SAFE_MARGIN,
        y,
        width: navWidth,
        height: navHeight,
        targetSlideId: slides[index - 1].id,
      }),
      id: `nav-back-${slide.id}`,
      generated: 'back',
    });
  }

  if (index < slides.length - 1) {
    elements.push({
      ...deckModel.makeButtonElement({
        label: 'Next  \u203a',
        fontSize: 'small',
        buttonStyle: 'plain',
        align: 'right',
        x: RASTER.width - SAFE_MARGIN - navWidth,
        y,
        width: navWidth,
        height: navHeight,
        targetSlideId: slides[index + 1].id,
      }),
      id: `nav-next-${slide.id}`,
      generated: 'next',
    });
  }

  return elements;
}

/**
 * Resolve a whole slide.
 *
 * Returns the resolved elements, the buttons that must exist on this menu page
 * in the DVD structure, and any problems the user should be told about.
 */
function layoutSlide(deck, slide) {
  const theme = getTheme(slide.themeId || deck.themeId);
  const authored = slide.elements.map((element) => resolveElement(element, theme));
  const nav = navigationElements(slide, deck.slides).map((element) => ({
    ...resolveElement(element, theme),
    generated: element.generated,
  }));

  const all = [...authored, ...nav];
  // A video tile plays something, so it needs a button region just as a button
  // does. Everything downstream then treats it exactly like a button, which is
  // what makes the remote able to choose it.
  const buttonElements = all.filter((e) => e.kind === 'button' || e.kind === 'video');

  const problems = [];
  if (buttonElements.length > MAX_BUTTONS_PER_SLIDE) {
    problems.push(
      `"${slide.title}" has ${buttonElements.length} buttons. A DVD menu can hold ` +
        `${MAX_BUTTONS_PER_SLIDE} comfortably \u2014 move some to another slide.`
    );
  }

  return {
    slide,
    theme,
    width: RASTER.width,
    height: RASTER.height,
    // How much wider this raster appears on a television than it is in pixels.
    // The drawing code needs it to place square-pixel pictures correctly.
    stretch: rasterStretch(deck.displayAspect || MENU_DISPLAY_ASPECT),
    /*
      A picture behind everything, if she chose one.

      `key` is the name it travels under in the decoded-picture map. It rides on
      the layout so the editor, the off-screen renderer and the drawing code all
      agree on it without a constant duplicated in three files.
    */
    background: {
      src:
        slide.backgroundImage && typeof slide.backgroundImage === 'string'
          ? slide.backgroundImage
          : null,
      fit: slide.backgroundFit === 'contain' ? 'contain' : 'cover',
    },
    backgroundKey: BACKGROUND_IMAGE_KEY,
    authored,
    navigation: nav,
    elements: all,
    buttons: buttonElements,
    problems,
  };
}

/**
 * Build the button rectangles the DVD structure needs.
 *
 * Coordinates come from the same resolved boxes the picture is drawn from, so
 * the highlight cannot drift away from the label. They are rounded to even
 * numbers because a DVD subpicture is addressed in two-pixel units, and an odd
 * value shifts the highlight half a pixel out of alignment.
 */
function buttonsForAuthoring(layout) {
  return layout.buttons.map((element, index) => ({
    id: element.id,
    index,
    // dvdauthor matches spumux rectangles to commands by button name, in order,
    // within a single menu page, so a simple positional name is correct and
    // unambiguous.
    name: `btn${index + 1}`,
    // Buttons resolve their label to `labelText`; video tiles keep theirs in
    // `label`. Both end up as the same thing here.
    label: element.labelText || element.label || '',
    videoId: element.videoId || null,
    targetSlideId: element.targetSlideId || null,
    x0: even(element.box.x),
    y0: even(element.box.y),
    x1: even(element.box.x + element.box.width),
    y1: even(element.box.y + element.box.height),
  }));
}

function even(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  return value % 2 === 0 ? value : value + 1;
}

/**
 * Keep an element inside the television-safe area.
 *
 * Applies to positions and to sizes, because both matter: an element dragged
 * to the edge would be cropped by the television, and one resized too large
 * would push its own text off the picture. Called on every mutation rather than
 * only when rendering, so an invalid deck can never be saved or burned.
 */
function clampElement(element, width, height) {
  const box = element.box || element;
  const maxWidth = width - SAFE_MARGIN * 2;
  // Video tiles sit above the navigation row (< Menu / Next > at y=408..440),
  // so their bottom edge is capped at y=396 to guarantee they never collide.
  const maxBottom = element.kind === 'video' ? 396 : (height - SAFE_MARGIN);
  const maxHeight = maxBottom - SAFE_MARGIN;
  const w = Math.min(Math.max(40, Math.round(box.width)), maxWidth);
  const h = Math.min(Math.max(24, Math.round(box.height)), maxHeight);
  const x = Math.min(Math.max(SAFE_MARGIN, Math.round(box.x)), width - SAFE_MARGIN - w);
  const y = Math.min(Math.max(SAFE_MARGIN, Math.round(box.y)), maxBottom - h);

  return {
    ...element,
    x,
    y,
    width: w,
    height: h,
  };
}

/**
 * Apply safe-area limits to every element of every slide.
 *
 * Runs over the whole deck on every edit, so there is a single invariant:
 * whatever is in the deck is placeable on a television. That keeps the guard
 * honest no matter which interaction produced the change — a drag, a resize, a
 * template, or a deck loaded from settings.
 */
function clampDeck(deck) {
  const width = RASTER.width;
  const height = RASTER.height;
  return {
    ...deck,
    slides: deck.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => {
        // Text and buttons grow to fit their content, so their stored height is
        // a floor rather than a fixed size.
        const clamped = clampElement(element, width, height);
        if (element.kind === 'text' && element.autoHeight !== false) {
          return { ...clamped, height: element.height };
        }
        return clamped;
      }),
    })),
  };
}

/** The whole deck, laid out. */
function layoutDeck(deck) {
  const slides = deck.slides.map((slide) => layoutSlide(deck, slide));
  const problems = slides.flatMap((layout) => layout.problems);
  return { deck, slides, problems };
}

module.exports = {
  BUTTON_STYLES,
  MENU_DISPLAY_ASPECT,
  LINE_HEIGHT,
  TEXT_PADDING_X,
  TEXT_PADDING_Y,
  CHAR_WIDTH_FACTOR,
  measureText,
  wrapText,
  textBlockHeight,
  resolveElement,
  navigationElements,
  layoutSlide,
  layoutDeck,
  buttonsForAuthoring,
  clampElement,
  clampDeck,
  rasterStretch,
  displayAspectToRaster,
  even,
};
