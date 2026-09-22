'use strict';

/**
 * Everything that touches real hardware: finding writers, building an ISO, and
 * burning it.
 *
 * Both platforms are driven through the operating system's own optical writer
 * support — `drutil` and `hdiutil` on macOS, IMAPI2 on Windows. That matters
 * more than it sounds: DVD Styler's burn problems come from linking against
 * third-party burning libraries that rot against new OS releases. The system
 * tools cannot fall out of step with the system.
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { isMac, isWindows } = require('./tools');
const windowsDisc = require('./disc_windows');
const { AbortError } = require('./encode');

const exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

/**
 * List optical writers.
 *
 * `drutil list` output looks like:
 *
 *   Vendor   Product           Rev   Bus           SupportLevel             DeviceNode
 *   HL-DT-ST DVDRAM GP65NB60   PF00  USB   Apple Shipping                 /dev/disk4
 *
 * The SupportLevel column is what tells us whether it can actually write.
 * An external USB writer on a 2017 MacBook Air lands here; the machine has no
 * internal drive at all.
 *
 * The columns are read by position, taken from the header line, because every
 * field can contain spaces — "DVDRAM GP65NB60" is one product name, and
 * "Apple Supported" is one support level. Splitting on whitespace and counting
 * back from the end gets both wrong: it reported the bus as "Apple" and the
 * product as "DVDRAM GP65NB60 DH61 USB", and then refused the drive because the
 * support level it compared against was the wrong word entirely.
 */
const DRUTIL_COLUMNS = ['Vendor', 'Product', 'Rev', 'Bus', 'SupportLevel', 'DeviceNode'];

function drutilColumnStarts(headerLine) {
  const starts = [];
  for (const name of DRUTIL_COLUMNS) {
    const at = headerLine.indexOf(name);
    if (at === -1) return null;
    starts.push({ name, at });
  }
  // The columns have to be in the order drutil prints them, or the slices below
  // would cut across fields.
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].at <= starts[i - 1].at) return null;
  }
  return starts;
}

/** One `drutil list` row, cut into its columns by the header's own positions. */
function parseDrutilRow(line, starts) {
  const field = {};
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : line.length;
    field[starts[i].name] = line.slice(from, to).trim();
  }
  return field;
}

/**
 * Turn the raw output of `drutil list` into drive records.
 *
 * Separated out so it can be tested against real output from a Mac without a
 * Mac and without a drive attached.
 */
function parseDrutilList(stdout) {
  const drives = [];
  const lines = String(stdout || '').split('\n');
  const headerLine = lines.find((l) => /Vendor\s+Product/i.test(l)) || '';
  // Null when the header is not the shape we know, in which case the row
  // parser below reads the fields by position from the end instead.
  const starts = drutilColumnStarts(headerLine);

  for (const line of lines) {
    if (!/\/dev\/disk\d+/.test(line)) continue;
    if (/^\s*Vendor\s+Product/i.test(line)) continue;

    const nodeMatch = /(\/dev\/disk\d+)/.exec(line);
    if (!nodeMatch) continue;

    let vendor = '';
    let product = '';
    let rev = '';
    let bus = '';
    let support = '';

    if (starts) {
      const field = parseDrutilRow(line, starts);
      vendor = field.Vendor || '';
      product = field.Product || '';
      rev = field.Rev || '';
      bus = field.Bus || '';
      support = field.SupportLevel || '';
    } else {
      // No usable header: take the device node off, and the four fields before
      // it are vendor, product, rev and bus, with the product being everything
      // between the first token and the last three.
      const beforeNode = line.slice(0, nodeMatch.index).trim();
      const supportMatch = /(Apple Shipping|Apple Supported|Unsupported)\s*$/i.exec(beforeNode);
      support = supportMatch ? supportMatch[1] : '';
      const head = supportMatch ? beforeNode.slice(0, supportMatch.index).trim() : beforeNode;
      const parts = head.split(/\s+/);
      vendor = parts[0] || '';
      bus = parts.length >= 2 ? parts[parts.length - 1] : '';
      rev = parts.length >= 3 ? parts[parts.length - 2] : '';
      product = parts.length >= 4 ? parts.slice(1, parts.length - 2).join(' ') : '';
    }

    /*
      A drive drutil lists is a drive it can write to, unless it says otherwise.

      This used to require the support level to read "Apple Shipping" or "Apple
      Supported" before the drive counted as usable. Anything else — including a
      level this does not recognise, or none at all — silently made a perfectly
      good burner invisible, which is a bad failure for a button whose whole job
      is to write a disc. Only an explicit "Unsupported" is taken at its word.
    */
    const unsupported = /Unsupported/i.test(support);

    drives.push({
      id: nodeMatch[1],
      device: nodeMatch[1],
      vendor,
      product,
      rev,
      bus,
      supportLevel: support,
      writeCapable: !unsupported,
      label: [vendor, product].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || nodeMatch[1],
    });
  }

  return drives;
}

async function listDrives({ drutil, diskutil } = {}) {
  if (isWindows) return windowsDisc.listDrives();
  if (!isMac) return { supported: false, drives: [], note: 'Burning discs needs Windows or macOS.' };

  const drives = [];
  // Kept and returned so Setup can show it. If a burner is plugged in and still
  // is not listed, this is the only thing that says why.
  let raw = '';

  if (drutil) {
    try {
      const { stdout } = await exec(drutil, ['list']);
      raw = stdout;
      drives.push(...parseDrutilList(stdout));
    } catch (err) {
      return {
        supported: true,
        drives: [],
        raw,
        note: 'The drive list could not be read. Connect the burner and try again.',
        error: String(err.message || err),
      };
    }
  }

  // Ask each device whether media is present, so the UI can say "insert a disc"
  // rather than failing at the end of a long burn.
  for (const drive of drives) {
    try {
      const { stdout } = await exec(drutil, ['status', '-drive', drive.device]);
      drive.media = summariseMedia(stdout);
    } catch {
      drive.media = { present: false, raw: '' };
    }
  }

  return { supported: true, drives, raw, note: null };
}

function summariseMedia(output) {
  const text = String(output || '');
  const present = /Type:\s*(?!No Media)/i.test(text) && !/No Media/i.test(text);
  const typeMatch = /Type:\s*(.+)/i.exec(text);
  const erasable = /Erasable:\s*(Yes|No|TRUE|FALSE)/i.exec(text);
  const appendable = /Appendable:\s*(Yes|No|TRUE|FALSE)/i.exec(text);
  const overWritable = /Overwritable:\s*(Yes|No|TRUE|FALSE)/i.exec(text);
  const freeMatch = /Free Space:\s*(.+)/i.exec(text);

  return {
    present,
    type: typeMatch ? typeMatch[1].trim() : null,
    erasable: erasable ? /yes|true/i.test(erasable[1]) : null,
    appendable: appendable ? /yes|true/i.test(appendable[1]) : null,
    overWritable: overWritable ? /yes|true/i.test(overWritable[1]) : null,
    freeSpace: freeMatch ? freeMatch[1].trim() : null,
    raw: text,
  };
}

/**
 * Build a DVD-compatible ISO from a folder.
 *
 * `hdiutil makehybrid` with `-udf` is the right call on macOS: DVD-Video is a
 * UDF filesystem, and a plain ISO9660 image without UDF is exactly the kind of
 * thing that plays on a computer and refuses to play on a set-top player.
 */
async function buildIso({ sourceDir, outputIso, volumeLabel, hdiutil, mkisofs, onProgress, signal }) {
  // Windows builds the image with IMAPI2, which is part of the OS.
  if (isWindows) return windowsDisc.buildIso({ sourceDir, outputIso, volumeLabel, signal });

  fs.mkdirSync(path.dirname(outputIso), { recursive: true });
  fs.rmSync(outputIso, { force: true });

  if (hdiutil) {
    return buildIsoHdiutil({ sourceDir, outputIso, volumeLabel, hdiutil, onProgress, signal });
  }
  if (mkisofs) {
    return buildIsoMkisofs({ sourceDir, outputIso, volumeLabel, mkisofs, onProgress, signal });
  }
  throw new Error(
    'No tool available to build a disc image. On macOS this should not happen; ' +
      'the system tool is built in.'
  );
}

function buildIsoHdiutil({ sourceDir, outputIso, volumeLabel, hdiutil, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      'makehybrid',
      '-o', outputIso,
      '-udf',
      '-iso-volume-name', volumeLabel || 'MY_DVD',
      '-udf-volume-name', volumeLabel || 'MY_DVD',
      '-default-volume-name', volumeLabel || 'MY_DVD',
      sourceDir,
    ];

    const child = spawn(hdiutil, args, { windowsHide: true });
    let out = '';

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

    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });

    child.on('error', (err) => reject(new Error(`Could not build the disc image: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new AbortError('Building the disc image was stopped.'));
      if (code !== 0) {
        return reject(new Error(describeIsoFailure(out)));
      }
      if (onProgress) onProgress(1);
      resolve({ isoPath: outputIso, log: out });
    });
  });
}

function buildIsoMkisofs({ sourceDir, outputIso, volumeLabel, mkisofs, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-udf',
      '-iso-level', '3',
      '-V', volumeLabel || 'MY_DVD',
      '-o', outputIso,
      sourceDir,
    ];

    const child = spawn(mkisofs, args, { windowsHide: true });
    let out = '';

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

    child.stdout.on('data', (c) => {
      out += c.toString();
      // mkisofs reports percentage on stderr; either way, look for a number.
      const m = /(\d{1,3})%/.exec(c.toString());
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 100));
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
      const m = /(\d{1,3})%/.exec(c.toString());
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 100));
    });

    child.on('error', (err) => reject(new Error(`Could not build the disc image: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new AbortError('Building the disc image was stopped.'));
      if (code !== 0) return reject(new Error(describeIsoFailure(out)));
      if (onProgress) onProgress(1);
      resolve({ isoPath: outputIso, log: out });
    });
  });
}

function describeIsoFailure(output) {
  const text = String(output || '');
  if (/No space left|not enough space/i.test(text)) {
    return 'Ran out of disk space while building the disc image.';
  }
  if (/Permission denied/i.test(text)) {
    return 'Not allowed to write the disc image. Choose a different working folder in Setup.';
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return `Building the disc image failed. ${line || 'No reason given.'}`;
}

/**
 * Burn an image to a real disc.
 *
 * `hdiutil burn` is the system path and uses the OS's own optical writer
 * support, including external USB burners. Progress is estimated from the
 * image size against elapsed time, because hdiutil reports progress as a
 * sequence of dots and percentages that varies between macOS versions.
 */
async function burnIso({ isoPath, device, hdiutil, onProgress, signal, verify = true }) {
  if (isWindows) return windowsDisc.burnIso({ isoPath, device, onProgress, signal });

  if (!isMac) {
    throw new Error('Burning a disc needs Windows or macOS.');
  }
  if (!hdiutil) throw new Error('The system burning tool could not be found.');

  const stat = fs.statSync(isoPath);
  const totalBytes = stat.size;

  return new Promise((resolve, reject) => {
    const args = ['burn', isoPath];
    if (verify) args.push('-verifyburn');
    if (device) args.push('-device', device);

    const child = spawn(hdiutil, args, { windowsHide: true });
    let out = '';
    const started = Date.now();

    const onAbort = () => {
      try {
        // Ask hdiutil to stop cleanly rather than yanking the device.
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const handle = (chunk) => {
      const text = chunk.toString();
      out = (out + text).slice(-8000);

      // Percentages when hdiutil provides them.
      const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
      if (pct && onProgress) {
        return onProgress(Math.min(0.99, Number(pct[1]) / 100));
      }

      // Otherwise estimate from the CD/DVD write speed. A conservative
      // "half real speed" estimate keeps the bar from finishing early and
      // then sitting still, which looks like a hang.
      if (onProgress && totalBytes > 0) {
        const elapsed = (Date.now() - started) / 1000;
        const assumedBytesPerSecond = 1.35 * 1024 * 1024; // ~1x DVD write
        onProgress(Math.min(0.97, (elapsed * assumedBytesPerSecond) / totalBytes));
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('error', (err) => reject(new Error(`Could not start burning: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) {
        return reject(new AbortError('Burning was stopped. The disc in the drive may be unusable.'));
      }
      if (code !== 0) return reject(new Error(describeBurnFailure(out)));

      if (onProgress) onProgress(1);
      resolve({ log: out });
    });
  });
}

function describeBurnFailure(output) {
  const text = String(output || '');
  if (/no media|NoMedia|not ready/i.test(text)) {
    return 'The drive has no disc in it. Put in a blank DVD-R and try again.';
  }
  if (/not enough space|too (big|large)|does not fit/i.test(text)) {
    return 'The disc is too small for this material. Use a blank DVD-R rather than a CD.';
  }
  if (/unwritable|read-only|write-protected|not writable/i.test(text)) {
    return 'This disc is not writable. It may already have been burned, or be a pressed disc.';
  }
  if (/Permission denied|not permitted|Authorization/i.test(text)) {
    return (
      'macOS would not allow the burn. Open System Settings, Privacy & Security, ' +
        'and check nothing is blocking Burnhouse.'
    );
  }
  if (/device.*not found|No such device/i.test(text)) {
    return 'The chosen drive is no longer connected. Reconnect the burner and try again.';
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return `Burning failed. ${line || 'No reason given.'}`;
}

/**
 * Copy a built disc folder somewhere permanent, for the case where she wants to
 * keep the disc contents and burn it later or on another machine.
 */
function copyDiscFolder({ videoTsDir, destination, onProgress }) {
  fs.mkdirSync(destination, { recursive: true });
  const entries = fs.readdirSync(videoTsDir);
  const total = entries.length;

  entries.forEach((entry, i) => {
    const from = path.join(videoTsDir, entry);
    const to = path.join(destination, entry);
    fs.copyFileSync(from, to);
    if (onProgress) onProgress((i + 1) / total);
  });

  return destination;
}

/**
 * How much free space a working folder has, so we can refuse a job that cannot
 * possibly finish rather than filling the disk. Returns null when it cannot be
 * determined.
 */
async function freeSpace(dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(dir);
      return stats.bavail * stats.bsize;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** A note for platforms that genuinely cannot burn. */
async function platformDiscNote() {
  if (isMac || isWindows) return null;
  return 'Burning discs is supported on Windows and macOS.';
}

module.exports = {
  listDrives,
  buildIso,
  burnIso,
  copyDiscFolder,
  freeSpace,
  platformDiscNote,
  summariseMedia,
  describeBurnFailure,
  describeIsoFailure,
  // Exported so the drive listing can be tested against real `drutil list`
  // output without a Mac and without a drive attached.
  parseDrutilList,
  drutilColumnStarts,
  parseDrutilRow,
};
