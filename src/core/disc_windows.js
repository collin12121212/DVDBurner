'use strict';

/**
 * Burning discs on Windows.
 *
 * The same principle as the macOS path: drive the operating system's own
 * optical burning support rather than linking a third-party library. Windows has
 * shipped IMAPI2 (the Image Mastering API) since Vista, reachable through COM,
 * and it handles external USB writers exactly like internal ones.
 *
 * All of it is done in PowerShell, which is the only scripting host guaranteed
 * to be present on Windows and which can talk to COM without compiling anything.
 * The scripts are written to a temporary file and run with `-File`, because
 * passing a script through `-Command` means fighting command-line quoting for
 * every path that contains a space.
 *
 * So the whole feature adds a .ps1 and nothing else: no bundled binaries, no
 * native module, nothing to rot against a future Windows release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { AbortError } = require('./encode');

const POWERSHELL = 'powershell.exe';

/** Run a PowerShell script that was written to a temporary file. */
function runScript(script, { onOutput, signal, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-ps-'));
    const scriptPath = path.join(dir, 'job.ps1');
    // UTF-8 with a BOM, so Windows PowerShell reads non-ASCII paths correctly.
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');

    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );

    let out = '';
    let err = '';

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      onAbort();
      reject(new Error('The disc tool stopped responding and was closed.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      out = (out + text).slice(-200000);
      if (onOutput) onOutput(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      err = (err + text).slice(-20000);
      if (onOutput) onOutput(text);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell could not be started: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* not important */
      }
      if (signal && signal.aborted) {
        return reject(new AbortError('The disc job was stopped.'));
      }
      if (code !== 0) {
        const line = `${err}\n${out}`.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        return reject(new Error(line || 'The disc tool failed.'));
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

/** The last JSON value a script printed, or null. */
function lastJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  // Any log lines come first; the result is the final line.
  const line = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Script shared by everything here: find a recorder.
 *
 * A recorder is identified by the disc master's device ID, which is stable
 * whether or not a disc is in the drive — a drive letter is not, because a
 * burner with no media has no volume at all.
 */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-Recorders {
  $list = @()
  try {
    $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  } catch {
    return $list
  }
  foreach ($id in $master) {
    try {
      $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2
      $recorder.InitializeDiscRecorder($id)
      $volumes = @()
      try { $volumes = @($recorder.VolumePathNames) } catch { }
      $list += [pscustomobject]@{ Id = $id; Recorder = $recorder; Volumes = $volumes }
    } catch { }
  }
  return $list
}

function Get-RecorderById($wanted) {
  foreach ($entry in (Get-Recorders)) {
    if ($entry.Id -eq $wanted) { return $entry }
  }
  return $null
}

# The media state flags, from IMAPI_FORMAT2_DATA_MEDIA_STATE.
function Get-MediaState($recorder) {
  $nothing = [pscustomobject]@{
    Present = $false; Blank = $false; Appendable = $false; Final = $false
    Unsupported = $false; Rewritable = $false
    FreeSectors = 0; TotalSectors = 0; State = -1; Text = 'No disc'
  }

  try {
    $format = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
    $format.Recorder = $recorder
    if (-not $format.IsCurrentMediaSupported($recorder)) { return $nothing }
    $state = [int]$format.CurrentMediaStatus
  } catch {
    return $nothing
  }

  $blankFlag = (($state -band 0x1) -ne 0)
  $appendable = (($state -band 0x2) -ne 0)
  $final = (($state -band 0x4) -ne 0)
  $unsupported = (($state -band 0x10) -ne 0)
  $overwriteOnly = (($state -band 0x20) -ne 0)

  # Free space is the honest measure of whether a disc is empty, and the flags
  # alone are not reliable.
  #
  # A brand new DVD-R in an hp DVDRW DU8A6SH is reported as
  # APPENDABLE | FINAL_SESSION with no BLANK bit at all - which reads as "already
  # written" if you trust the flags, and rejected perfectly good discs. The same
  # disc reports 2,297,888 free sectors out of 2,297,888, and a next writable
  # address of zero: nothing has ever been written to it.
  #
  # So a disc that has as much free space as it has in total is treated as blank
  # whatever the drive calls it.
  $free = 0
  $total = 0
  try { $free = [int64]$format.FreeSectorsOnMedia } catch { }
  try { $total = [int64]$format.TotalSectorsOnMedia } catch { }

  $blank = $blankFlag -or ($total -gt 0 -and $free -ge $total)

  $text = if ($unsupported) { 'Unsupported disc' }
    elseif ($blank) { 'Blank' }
    elseif ($appendable) { 'Partly used' }
    elseif ($overwriteOnly) { 'Rewritable' }
    elseif ($final) { 'Already written' }
    else { 'Present' }

  return [pscustomobject]@{
    Present = $true
    Blank = $blank
    Appendable = $appendable
    Final = $final
    Unsupported = $unsupported
    Rewritable = $overwriteOnly
    FreeSectors = $free
    TotalSectors = $total
    State = $state
    Text = $text
  }
}
`;

/** List the optical writers attached to this computer. */
async function listDrives() {
  const script = `${PRELUDE}
$out = @()
foreach ($entry in (Get-Recorders)) {
  $media = Get-MediaState $entry.Recorder
  $volumes = @($entry.Volumes)
  $label = ("$($entry.Recorder.VendorId) $($entry.Recorder.ProductId)").Trim()
  $out += [pscustomobject]@{
    id = $entry.Id
    label = $label
    vendor = $entry.Recorder.VendorId
    product = $entry.Recorder.ProductId
    revision = $entry.Recorder.ProductRevision
    volumePath = $(if ($volumes.Count -gt 0) { $volumes[0] } else { $null })
    mediaPresent = $media.Present
    mediaText = $media.Text
    mediaBlank = $media.Blank
    mediaRewritable = $media.Rewritable
    mediaFreeSectors = $media.FreeSectors
    mediaTotalSectors = $media.TotalSectors
  }
}
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

  const { stdout } = await runScript(script, { timeoutMs: 60000 });
  const parsed = lastJson(stdout);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  const drives = rows.map((row) => ({
    id: row.id,
    device: row.id,
    vendor: row.vendor || '',
    product: row.product || '',
    rev: row.revision || '',
    bus: 'USB',
    supportLevel: row.mediaText || '',
    writeCapable: true,
    volumePath: row.volumePath || null,
    label: [row.label, row.volumePath].filter(Boolean).join('  ').trim() || row.id,
    media: {
      present: Boolean(row.mediaPresent),
      type: row.mediaText || null,
      erasable: Boolean(row.mediaRewritable),
      blank: Boolean(row.mediaBlank),
      /*
        Free space as a figure, not just a word.

        The drive list used to show whatever the media-state flags happened to
        say. This drive calls a brand new DVD-R "Partly used", which is alarming
        and wrong — the disc had 2,297,888 free sectors out of 2,297,888. A
        number cannot be misread that way, so the free space is reported in the
        same terms a blank disc is sold in.
      */
      freeSpace: formatDiscSpace(row.mediaFreeSectors, row.mediaTotalSectors),
      raw: row.mediaText || '',
    },
  }));

  return {
    supported: true,
    drives,
    note: drives.length
      ? null
      : 'No disc writer was found. Plug the burner in and press Refresh.',
  };
}

/**
 * A helper for copying a COM stream to a file.
 *
 * PowerShell cannot cast the object IMAPI hands back to `IStream` — it fails
 * with an invalid-cast error, because the interop wrapper does not expose the
 * interface to PowerShell's type system. C# can do the cast, so a few lines are
 * compiled once at run time with `Add-Type` and used instead. Compiling takes
 * about a second, which is nothing next to writing a DVD image.
 */
const STREAM_COPY_HELPER = `
if (-not ('BurnhouseStreamCopy' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class BurnhouseStreamCopy
{
    public static long ToFile(object comStream, string path)
    {
        IStream stream = (IStream)comStream;
        long total = 0;
        using (FileStream file = File.Create(path))
        {
            byte[] buffer = new byte[1 << 20];
            IntPtr readPtr = Marshal.AllocCoTaskMem(4);
            try
            {
                while (true)
                {
                    stream.Read(buffer, buffer.Length, readPtr);
                    int read = Marshal.ReadInt32(readPtr);
                    if (read <= 0) { break; }
                    file.Write(buffer, 0, read);
                    total += read;
                }
            }
            finally
            {
                Marshal.FreeCoTaskMem(readPtr);
            }
        }
        return total;
    }
}
'@
}
`;

/** Build a DVD-Video image.
 *
 * UDF is not optional: DVD-Video is a UDF filesystem, and an image with only
 * ISO9660 is exactly the kind of disc that plays on a computer and refuses to
 * play in a set-top player. `FileSystemsToCreate = 7` is ISO9660 + Joliet + UDF.
 *
 * `sourceDir` is the folder that CONTAINS VIDEO_TS, which is what the mkisofs and
 * hdiutil paths are given. One contract for all three, and this one used to
 * disagree with it: it treated sourceDir as being VIDEO_TS itself and added the
 * whole tree with its base folder included, so the disc root came out as a
 * single directory called `author` with the real VIDEO_TS buried inside it.
 *
 * The disc held a perfectly good VIDEO_TS and a DVD player showed a file browser
 * instead of playing it, because as far as the player was concerned this was a
 * data disc with a folder on it. Which is what it was.
 *
 * Only the two folders a DVD-Video disc may have are added, so the authoring
 * folder's other contents — dvdauthor.xml, the menu stills, scratch files —
 * stay off the disc.
 *
 * The folders are added by reference — `AddTree` reads them as it writes — so
 * nothing is copied and a four gigabyte disc does not need four gigabytes of
 * scratch space.
 */
async function buildIso({ sourceDir, outputIso, volumeLabel, signal }) {
  fs.mkdirSync(path.dirname(outputIso), { recursive: true });
  fs.rmSync(outputIso, { force: true });

  const videoTs = path.join(sourceDir, 'VIDEO_TS');
  const audioTs = path.join(sourceDir, 'AUDIO_TS');

  const script = `${PRELUDE}
${STREAM_COPY_HELPER}
$videoTs = ${psQuote(videoTs)}
$audioTs = ${psQuote(audioTs)}
$output = ${psQuote(outputIso)}
$label = ${psQuote(String(volumeLabel || 'MY_DVD').slice(0, 32))}

if (-not (Test-Path -LiteralPath $videoTs)) { throw "The VIDEO_TS folder is missing: $videoTs" }

$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 7
$image.VolumeName = $label

# The base directory is included, so VIDEO_TS lands at the root of the disc
# rather than its contents being spilled loose among the root files.
$image.Root.AddTree($videoTs, $true)
if (Test-Path -LiteralPath $audioTs) { $image.Root.AddTree($audioTs, $true) }

$result = $image.CreateResultImage()
$written = [BurnhouseStreamCopy]::ToFile($result.ImageStream, $output)

[pscustomobject]@{ isoPath = $output; bytes = $written } | ConvertTo-Json -Compress
`;

  const { stdout } = await runScript(script, { signal, timeoutMs: 30 * 60 * 1000 });
  const result = lastJson(stdout);
  if (!result || !fs.existsSync(outputIso)) {
    throw new Error('The disc image was not produced.');
  }
  return { isoPath: outputIso, bytes: result.bytes, log: stdout };
}

/**
 * Write an image to a real disc.
 *
 * `Write` blocks until the whole image is on the disc, so progress is estimated
 * from the image size and elapsed time, the same way the macOS path does. The
 * estimate is deliberately conservative: a bar that finishes early and then sits
 * still looks like a hang.
 */
async function burnIso({ isoPath, device, onProgress, signal }) {
  if (!fs.existsSync(isoPath)) throw new Error('The disc image is missing.');

  const totalBytes = fs.statSync(isoPath).size;
  const script = `${PRELUDE}
$iso = ${psQuote(isoPath)}
$wanted = ${psQuote(device || '')}

$entry = $null
if ($wanted -ne '') { $entry = Get-RecorderById $wanted }
if ($entry -eq $null) {
  $all = @(Get-Recorders)
  if ($all.Count -eq 0) { throw 'No disc writer was found. Plug the burner in and try again.' }
  $entry = $all[0]
}

$media = Get-MediaState $entry.Recorder
if (-not $media.Present) {
  throw 'The drive has no disc in it. Put in a blank DVD-R and try again.'
}
if ($media.Unsupported) {
  throw 'This disc cannot be written by this drive. Use a blank DVD-R.'
}

# Refuse a disc that is genuinely used up, and say which of the two it is: too
# small, or already written to. Space is what decides, because the flags do not
# mean what they look like on every drive.
$needSectors = [int64][math]::Ceiling((Get-Item -LiteralPath $iso).Length / 2048)
if (-not $media.Blank -and -not $media.Rewritable) {
  if ($media.FreeSectors -gt 0 -and $media.FreeSectors -lt $needSectors) {
    if ($media.FreeSectors -lt 300000) {
      throw 'That looks like a CD, not a DVD. This disc needs a blank DVD-R.'
    }
    throw 'This disc already has something on it. Use a blank DVD-R.'
  }
  # No usable free-space figure, so let IMAPI decide. It gives a precise error
  # and describeBurnFailure turns it into something readable.
}

$format = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
$format.Recorder = $entry.Recorder
$format.ClientName = 'Burnhouse'
try { $format.ForceMediaToBeClosed = $true } catch { }

$stream = New-Object -ComObject ADODB.Stream
$stream.Type = 1
$stream.Open()
$stream.LoadFromFile($iso)

try {
  $format.Write($stream)
} finally {
  try { $stream.Close() } catch { }
}

[pscustomobject]@{ ok = $true; recorder = $entry.Recorder.ProductId } | ConvertTo-Json -Compress
`;

  // A running estimate, so the progress bar moves while `Write` blocks.
  let timer = null;
  if (onProgress) {
    const started = Date.now();
    const assumedBytesPerSecond = 1.35 * 1024 * 1024;
    timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      onProgress(Math.min(0.97, (elapsed * assumedBytesPerSecond) / totalBytes));
    }, 1000);
  }

  try {
    const { stdout } = await runScript(script, {
      signal,
      timeoutMs: 60 * 60 * 1000,
      onOutput: () => {},
    });
    const result = lastJson(stdout);
    if (!result || !result.ok) throw new Error('The burn did not report success.');
    if (onProgress) onProgress(1);
    return { log: stdout };
  } catch (err) {
    throw new Error(describeBurnFailure(err.message));
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** A single-quoted PowerShell string, with quotes escaped the PowerShell way. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * How much room is on the disc, in the terms a blank disc is sold in.
 *
 * A sector is 2048 bytes, and a "4.7 GB" DVD-R is 2,297,888 of them. Showing the
 * figure means an empty disc reads as empty even when the drive's own summary of
 * it does not.
 */
function formatDiscSpace(freeSectors, totalSectors) {
  const free = Number(freeSectors) || 0;
  const total = Number(totalSectors) || 0;
  if (!total) return null;

  const gb = (sectors) => (sectors * 2048) / 1e9;
  if (free <= 0) return `full (${gb(total).toFixed(1)} GB disc)`;
  if (free >= total) return `blank, ${gb(total).toFixed(1)} GB free`;
  return `${gb(free).toFixed(1)} GB free of ${gb(total).toFixed(1)} GB`;
}

/** Turn IMAPI's messages into something worth showing somebody. */
function describeBurnFailure(message) {
  const text = String(message || '');
  if (/no disc|no media|NoMedia/i.test(text)) {
    return 'The drive has no disc in it. Put in a blank DVD-R and try again.';
  }
  if (/no disc writer|No disc writer/i.test(text)) {
    return 'No disc writer was found. Plug the burner in and try again.';
  }
  if (/already has something|not blank|not writable|read-only/i.test(text)) {
    return 'This disc is not writable. It may already have been burned, or be a pressed disc.';
  }
  if (/too (big|large)|does not fit|not enough space/i.test(text)) {
    return 'The disc is too small for this material. Use a blank DVD-R rather than a CD.';
  }
  if (/access is denied|denied|permission/i.test(text)) {
    return 'Windows would not allow the burn. Close any other disc program and try again.';
  }
  if (/cannot be written by this drive|unsupported/i.test(text)) {
    return 'This drive cannot write this kind of disc. Use a blank DVD-R.';
  }
  return `Burning failed. ${text || 'No reason given.'}`;
}

/** Whether this computer can burn, and what is missing if not. */
function platformNote() {
  return null;
}

module.exports = {
  listDrives,
  buildIso,
  burnIso,
  describeBurnFailure,
  platformNote,
};
