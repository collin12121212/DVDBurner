# Burnhouse

Make a DVD that plays in a normal DVD player.

Add videos, design a menu, put in a blank disc, press Burn. Everything needed is
inside the app — there is nothing else to install.

This is a replacement for DVD Styler, written because DVD Styler crashes when
you drag videos onto it. It is built for a 2017 MacBook Air running macOS 12
Monterey with an external USB DVD writer.

---

## For the person using it

### Installing it

1. Open the `Burnhouse.dmg` file you were given.
2. Drag **Burnhouse** into the **Applications** folder.
3. Open **Applications**, **right-click** Burnhouse, and choose **Open**.
   It will ask if you are sure — choose **Open** again.

That last step is only needed the first time. macOS says the app is from an
"unidentified developer" because it was built for you rather than bought from
Apple, and the right-click is how you tell it you trust it. Double-clicking will
not work the first time; the right-click will.

You can skip that step entirely by opening **Terminal** and running this once:

```
xattr -dr com.apple.quarantine /Applications/Burnhouse.app
```

### Using it

The app **is** the slide editor. There are two steps across the top: **Slides**,
and **Finish**.

**Slides** — this is the whole program. On the left are your slides; in the
middle is the one you are working on; on the right is the panel with two tabs.

A new project already has two slides: a **menu** that will list everything, and
a slide to put episodes on. The menu slide fills itself in as you add videos, so
you never have to remember to add a button.

- **Videos tab** (right panel) — press *Add Videos* to choose files, or drag
  them from Finder straight onto the window. Each one appears on the menu slide
  by itself. Click a name to rename it; that is what shows on the disc.
- **Design tab** (right panel) — click anything on the slide to change its
  words, size, lettering and colour. Drag it to move it. Arrow keys nudge it.
  Delete removes it.
- **Drag a video from the Videos tab onto a slide** to make a button that plays
  it, dropped where you aimed it.
- **Add blank slide** for another page, or **Add menu slide** for another page
  that lists everything.
- Slides that are not menus get **Back** and **Next** buttons automatically, so
  a disc with several pages is never a dead end. Choosing an episode plays it
  and then returns to the menu.

**Finish** — put a blank **DVD-R** or **DVD+R** in the burner and press
**Burn the Disc**. Don't take the disc out until it says it has finished. It
writes the disc and then reads it back to check it, which takes a few minutes.

If you are not ready to burn, you can press **Save a Disc Image** instead. That
makes a single file holding the whole DVD which you can burn later or keep as a
backup.

There are no format settings anywhere. The video system, frame rate and sound
format are all decided for you, because getting any of them wrong is the main
reason a burned DVD will not play.

### If something goes wrong

- **The disc will not play.** Use a fresh blank DVD-R, and check it plays in a
  computer — if it plays there, the disc itself is fine.
- **A video was left off the disc.** It is either damaged or in a format that
  cannot be read. Burnhouse says which one on the Finish step.
- **The burn failed.** Use a fresh blank disc, and keep the burner plugged in
  until it finishes. Some discs are faulty out of the packet.
- **You want to know what actually happened.** Press **Details** at the bottom
  while it is working. It shows everything the video tools reported.

### Your videos are never changed

Burnhouse only ever reads your original files. Everything it makes goes into its
own folder, and nothing you already have can be altered or lost.

---

## For whoever is building it

### What this is

An Electron application. The renderer is plain DOM with no framework and no
build step, so there is nothing to compile and nothing to go stale.

Two decisions shape everything else.

**One drawing implementation.** The editor preview, the filmstrip thumbnails
and the picture burned to the disc are all produced by `src/core/slide_draw.js`,
running from the same resolved layout (`src/core/slide_layout.js`). The only
difference is *where* it runs: a visible window, or a hidden one whose canvas is
read back as a PNG. There is no second implementation to drift out of step, so
the preview cannot lie about what will be on the disc.

**The deck model is the disc model.** A DVD menu is a still picture with
invisible button regions the player composites a highlight into, and that is
exactly what a slide is. So "make a menu listing the episodes" is not a special
feature — `author.js` just turns each slide into a menu page and each button
element into a `<button>` with a command. Slides become PGCs; videos become
titles; buttons become `jump title N` or `jump menu N`.

### Layout

```
src/core/       the pipeline — no Electron, no interface
  dvd_spec.js     DVD-Video rules: rasters, frame rates, bitrate budgets
  tools.js        finding ffmpeg / dvdauthor / hdiutil
  probe.js        reading facts out of a video with ffprobe
  encode.js       ffmpeg -> spec-legal MPEG-2 program streams
  deck.js         the slides, elements and generated episode lists
  slide_layout.js geometry: text wrapping, boxes, button rectangles
  slide_draw.js   slide drawing (runs in the window AND offscreen)
  deck_render.js  rendering a whole deck to PNGs
  author.js       dvdauthor XML and spumux button geometry
  themes.js       the eight preset palettes
  disc.js         drive detection, ISO building, burning
  pipeline.js     the order of operations
src/main/       Electron main process
src/preload/    the IPC bridge
src/renderer/   the interface
src/server/     the LAN sharing server
scripts/        dependency bundling for the Mac build
test/           the test suites
```

### Testing

```
npm install
npm test                  # core pipeline + sharing server
npm run test:menu         # renders menus and inspects the pixels
npx electron test/smoke.js   # launches the app and checks it paints
```

The core tests actually run ffmpeg on generated clips and read the result back
with ffprobe, checking resolution, frame rate, pixel format and audio sample
rate against the DVD spec. They are not mocks.

The menu tests render every preset theme and every awkward case — a
twenty-entry episode list, a title card, a slide with a picture, a single
unbreakable word, seven explicit line breaks — then inspect the pixels. A canvas
that silently draws nothing produces a perfectly valid DVD with a blank menu,
which no amount of XML checking would catch.

Tests that need a tool the machine does not have report **SKIP** with the
reason. A test that silently does nothing is worse than no test.

### Building the Mac app

You cannot build a Mac app on Windows or Linux. The build runs in GitHub
Actions, which provides a macOS runner:

1. Push this repository to GitHub (it can be private).
2. The **Build Burnhouse for macOS** workflow runs automatically.
3. When it finishes, download the `.dmg` from the run's artifacts.

To get a versioned release, push a tag:

```
git tag v1.0.0
git push origin v1.0.0
```

The workflow:

- runs the full test suite against real `ffmpeg` and a real `dvdauthor`, so a
  broken authoring step fails the build rather than shipping;
- collects Homebrew's `ffmpeg`, `ffprobe`, `dvdauthor` and `spumux`;
- **relocates their dynamic libraries** (`scripts/bundle-deps.sh`) so the app
  carries everything it needs and the target Mac needs nothing installed;
- verifies the relocated tools still run with Homebrew entirely off the PATH —
  this is the check that catches a missed library;
- build a universal binary covering both Intel and Apple silicon;
- attaches the `.dmg` and `.zip` to the release.

### Why the app is ad-hoc signed, not notarised

Notarising requires a paid Apple Developer account. The build uses an ad-hoc
signature with a hardened runtime, which is enough for the app to run once
Gatekeeper has been told to trust it — hence the right-click instructions above.

The entitlements in `build/entitlements.mac.plist` are not optional. A
hardened-runtime app has its child processes killed on launch without
`allow-unsigned-executable-memory`, `allow-jit` and
`disable-library-validation`, which is precisely the silent failure this app
exists to avoid.

### The sharing server

`npm run serve` starts a small file server for moving videos between computers
on the same network, and for downloading the built `.dmg`. It is also reachable
from the app's **Share** button.

It binds to the local network only, serves from exactly two directories, and
refuses any path outside them. Uploads stream straight to disk rather than
buffering in memory, because a DVD's worth of video will not fit in memory.

### What is deliberately not here

- **No bundled mpv or VLC.** A standard DVD-Video disc plays on a Mac, on a
  set-top player, and in VLC, so shipping a player would add over a hundred
  megabytes to solve a problem that does not exist.
- **No project files.** The slide deck persists with the settings, so opening
  the app again is close to where you left off, without a file format to manage.
- **No format settings exposed.** The video system is NTSC, chosen for North
  America, and never shown. The wrong answer here is the single most common
  reason a burned DVD will not play, so it is not a question she is asked.
- **No free-form canvas.** Elements snap to the television-safe area and are
  listed rather than rotated, layered or scaled freely. A menu that looks
  deliberate is worth more than one that can be arranged into a mess.

### Known limits

- Burning requires macOS. On other platforms the app builds disc images but
  cannot write them.
- A single-layer DVD holds about two hours of good-quality video. More than that
  and Burnhouse says so, rather than quietly producing a poor disc.
- A DVD menu holds 36 buttons at most, and Burnhouse caps a slide at 18 before
  it becomes unreadable on a television. Episode lists page themselves across
  several slides rather than overrunning.

### Licence

MIT.
