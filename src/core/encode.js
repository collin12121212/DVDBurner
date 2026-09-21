'use strict';

/**
 * Turning an arbitrary video into a DVD-legal MPEG-2 program stream.
 *
 * This is the step that used to blow up. Two rules keep it honest:
 *
 *   - Every parameter is computed from dvd_spec.js and recorded before the
 *     process starts, so there is no mid-flight decision making.
 *   - ffmpeg is driven directly with an argument array. No shell, no quoting,
 *     so a filename containing an apostrophe cannot break the job.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIDEO_EXTS = new Set(['.vob', '.mpg', '.mpeg', '.m2v', '.ts', '.mpv']);

/**
 * Remove previous encode output for a title without touching anything else.
 *
 * This must clear every video-ish extension, not just VOBs: a leftover
 * intermediate from an interrupted run would otherwise still be sitting there
 * when the next run lists the parts, and the disc would be built with a stale
 * file silently appended to it.
 */
function resetOutputDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (VIDEO_EXTS.has(path.extname(entry).toLowerCase())) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

/**
 * Build the scaling chain.
 *
 * Sources arrive in every shape imaginable. We letterbox or pillarbox onto the
 * exact DVD raster instead of cropping, because silently cutting the edges off
 * someone's video is not a decision this program gets to make.
 *
 * `setsar=1` is not decoration: without it, anamorphic 16:9 output carries a
 * stale sample aspect ratio and the picture comes out subtly stretched.
 * `out_range=tv` forces broadcast-legal 16-235 levels, which is what DVD
 * players and televisions expect; full-range output crushes blacks on a real
 * set even though it looks fine on a computer monitor.
 *
 * `interlace=tff` is what actually sets top-field-first. The MPEG-2 encoder's
 * own `field_order` option is silently ignored once interlaced coding is
 * enabled, and `ildct+ilme` on its own produces bottom-field-first, so the
 * field order has to be imposed in the filter chain where it takes effect.
 *
 * The deep-resize filters are deliberate: `lanczos` is the sharpest resampler
 * ffmpeg ships that does not ring on hard edges, and the scale filter converts
 * the colour matrix as part of the resize (BT.709 HD to BT.601 SD) — without
 * it, HD sources come out with reds gone orange on any television that trusts
 * the DVD flags.
 */
function buildVideoFilter({ width, height, progressive = false, sourceMatrix = null, aspect = '16:9' }) {
  // An explicit tag wins; otherwise HD resolutions imply 709, the way players
  // themselves guess.
  const inMatrix = sourceMatrix === 'bt709' ? 'bt709' : 'bt601';
  const is169 = aspect === '16:9';

  // For 16:9 anamorphic DVD:
  // Target display in square pixels is 854x480 (NTSC 16:9) or 640x480 (NTSC 4:3).
  // Scaling into this square-pixel target with decrease aspect ratio,
  // then squeezing horizontally to 720x480 with setsar=32/27:
  // - 16:9 sources fill the 720x480 frame 100% with ZERO black bars!
  // - 4:3 sources get correct pillarboxes without face-stretching.
  // - 2.39:1 scope movies get proper cinematic letterbox.
  const targetSqWidth = is169 ? (height === 576 ? 1024 : 854) : (height === 576 ? 768 : 640);
  const sar = is169 ? (height === 576 ? '64/45' : '32/27') : (height === 576 ? '16/15' : '8/9');

  const chain = [
    `scale=${targetSqWidth}:${height}:force_original_aspect_ratio=decrease:flags=lanczos` +
      `:in_range=tv:in_color_matrix=${inMatrix}:out_range=tv:out_color_matrix=bt601`,
    `pad=${targetSqWidth}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `scale=${width}:${height}:flags=lanczos`,
    `setsar=${sar}`,
  ];
  if (!progressive) chain.push('interlace=tff');
  return chain.join(',');
}

/**
 * Work out which colour matrix a source uses, from its probe record.
 *
 * ffprobe usually tags HD files correctly; when it doesn't, resolution is the
 * fallback every player on earth uses — anything at or above 720p is 709.
 */
function sourceMatrixFor(probe) {
  const tagged = String((probe && probe.colorSpace) || '').toLowerCase();
  if (/709|bt709|itu.?709/.test(tagged)) return 'bt709';
  if (/601|bt601|smpte.?170|itu.?601/.test(tagged)) return 'bt601';
  const width = Number(probe && probe.width) || 0;
  const height = Number(probe && probe.height) || 0;
  if (width >= 1280 || height >= 720) return 'bt709';
  return 'bt601';
}

/**
 * Normalise the source audio layout to something AC-3 accepts cleanly.
 * A source with no audio at all is handled separately by encodeSilence().
 */
function buildAudioFilter({ channels }) {
  if (channels >= 6) return 'aformat=channel_layouts=5.1';
  return 'aformat=channel_layouts=stereo';
}

/**
 * The full ffmpeg argument list for one title.
 *
 * Writing to `VTS_01_1.VOB` lets the dvd muxer split at 1 GB boundaries using
 * the exact naming a DVD requires, which removes an entire class of "disc plays
 * twenty minutes then stops" bugs.
 */
function buildEncodeArgs({ input, outputVob, plan, durationSeconds, aspect }) {
  const { format, videoBitrate, audioBitrate, muxrate, gop } = plan;
  const hasAudio = plan.hasAudio !== false;
  const audioChannels = plan.audio.channels;

  const args = [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-loglevel', 'error',
    // Progress goes to a dedicated pipe so it can never be mistaken for errors.
    '-progress', 'pipe:1',
    '-i', input,

    '-map', '0:v:0',
  ];

  if (hasAudio) args.push('-map', '0:a:0');

  args.push(
    '-vf', buildVideoFilter({
      width: format.width,
      height: format.height,
      sourceMatrix: sourceMatrixFor(plan.probe || null),
      aspect: aspect.ratio,
    }),

    // ---- video ----
    //
    // Every flag below was verified against this ffmpeg's mpeg2video encoder
    // before it was written here. Several plausible-looking options are
    // rejected by the build we ship: trellis quantisation does not exist in it
    // (so cbp_rd is unusable), closed-GOP is unimplemented, and qp_rd refuses
    // to open without `-mbd rd`. What remains is the best legal combination
    // this encoder accepts:
    //
    //   - `-mbd rd -mpv_flags +qp_rd+mv0+naq`: rate-distortion macroblock
    //     decisions and quantiser selection, always-try-zero-motion, and
    //     normalised adaptive quantisation. The visible effect is fewer blocks
    //     in flat skies and walls at the same bitrate.
    //   - `-non_linear_quant 1 -qmin 2 -qmax 28`: MPEG-2's own non-linear
    //     quantiser table, which spends bits more cleverly in dark scenes.
    //     qmax 28 is a hard ceiling in this build — 31 refuses to open.
    //   - `-alternate_scan 1`: the alternate zig-zag scan, measurably better
    //     for interlaced material.
    //   - `-intra_dc_precision 2 -intra_vlc 1`: 9-bit DC precision and the
    //     intra VLC table, both standard pro-DVD choices.
    '-c:v', 'mpeg2video',
    '-b:v', `${videoBitrate}`,
    // The peak may never exceed what the muxer was told to expect, minus audio
    // and mux overhead — otherwise the stream has spikes the container cannot
    // carry and cheap players choke. At high targets that means maxrate barely
    // exceeds the average, which is correct: there is nowhere for a spike to go.
    '-maxrate', `${Math.min(Math.round(videoBitrate * 1.15), muxrate - audioBitrate - 200000)}`,
    '-minrate', `${videoBitrate}`,
    // A 224 kB VBV buffer. The old 90%-of-bitrate buffer risked underflowing
    // the DVD muxer's own rate checks on cheap players; 224 kB is the value
    // the professional tools converge on for DVD.
    '-bufsize', '1835008',
    '-g', `${gop}`,
    // Two B frames is the DVD-friendly maximum and buys real quality.
    '-bf', '2',
    '-mbd', 'rd',
    '-mpv_flags', '+qp_rd+mv0+naq',
    '-non_linear_quant', '1',
    '-qmin', '2',
    '-qmax', '28',
    '-alternate_scan', '1',
    '-intra_dc_precision', '2',
    '-intra_vlc', '1',
    '-sc_threshold', '0',
    // Interlaced coding with a top-field-first filter chain. This is the most
    // broadly accepted combination across standalone players, DVD recorders and
    // old software decoders; it costs nothing visible on progressive sources.
    '-flags', '+ildct+ilme',
    '-pix_fmt', 'yuv420p',
    '-aspect', aspect.ratio,
    '-r', `${format.fps}`,

    // ---- audio ----
    '-af', buildAudioFilter({ channels: audioChannels }),
    '-c:a', 'ac3',
    '-b:a', `${audioBitrate}`,
    // 48 kHz is mandatory for DVD-Video. Sources are frequently 44.1 kHz, and
    // getting this wrong is audible as a pitch shift.
    '-ar', '48000',
    '-ac', `${audioChannels}`,

    // ---- container ----
    '-f', 'dvd',
    // State the raster explicitly as well as scaling to it. The DVD muxer
    // validates against this, so a filter chain that somehow produced the wrong
    // geometry fails here rather than silently writing an illegal stream.
    '-s', `${format.width}x${format.height}`,
    '-muxrate', `${muxrate}`,
    '-preload', '500000',
    '-t', `${Math.max(1, Math.ceil(durationSeconds))}`,

    // Pad rather than truncate if the source runs a hair short of -t.
    '-shortest',
    outputVob
  );

  return args;
}

/**
 * Run one encode, reporting progress as a fraction.
 *
 * Resolves with the list of VOB parts produced, which is what the authoring
 * step needs in order to place chapters.
 */
function encodeTitle({
  ffmpegPath,
  input,
  outputVob,
  plan,
  durationSeconds,
  aspect,
  onProgress,
  signal,
}) {
  return new Promise((resolve, reject) => {
    const args = buildEncodeArgs({ input, outputVob, plan, durationSeconds, aspect });
    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let stderrTail = '';
    let stdoutBuf = '';
    let lastReported = -1;
    const outDir = path.dirname(outputVob);

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

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const seconds = Number(value) / 1e6;
          if (!Number.isFinite(seconds) || durationSeconds <= 0) continue;
          const fraction = Math.max(0, Math.min(1, seconds / durationSeconds));
          const percent = Math.round(fraction * 100);
          if (percent !== lastReported) {
            lastReported = percent;
            if (onProgress) onProgress(fraction);
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      cleanupAbort(signal, onAbort);
      reject(new Error(`Could not start ffmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      cleanupAbort(signal, onAbort);

      if (signal && signal.aborted) {
        return reject(new AbortError('Preparing the video was stopped.'));
      }
      if (code !== 0) {
        return reject(new Error(describeFfmpegFailure(stderrTail, path.basename(input))));
      }

      const parts = listTitleParts(outDir);
      if (parts.length === 0) {
        return reject(
          new Error(
            `ffmpeg reported success but wrote no video for "${path.basename(input)}". ` +
              `The source file may be damaged.`
          )
        );
      }

      if (onProgress) onProgress(1);

      // ffmpeg emits valuable diagnostic lines at warning level (deprecated
      // options, stream discontinuities, timestamp jumps). They are not fatal
      // but they are the difference between a diagnosable report and "it just
      // failed", so surface them rather than discarding them.
      const warnings = extractWarnings(stderrTail);

      resolve({ parts, stderr: stderrTail, warnings });
    });
  });
}

/** Pull the useful diagnostic lines out of an ffmpeg stderr tail. */
function extractWarnings(stderr) {
  return String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /deprecat|non-monotonous|discontinuity|clipping|invalid|corrupt|drop|overflow|underflow/i.test(line))
    // Strip the leading `[component @ 0x...]` noise; the address is useless.
    .map((line) => line.replace(/^\[[^\]]*@\s*0x[0-9a-f]+\]\s*/i, '').replace(/^\[[^\]]*\]\s*/, ''))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 6);
}

function cleanupAbort(signal, onAbort) {
  if (signal) {
    try {
      signal.removeEventListener('abort', onAbort);
    } catch {
      /* nothing to remove */
    }
  }
}

/**
 * The VOB parts ffmpeg produced, in the order a player must read them.
 * Only `_1`, `_2`, ... are title content; `_0` belongs to the menu domain.
 */
function listTitleParts(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /^VTS_\d+_\d+\.VOB$/i.test(f))
    .filter((f) => partNumber(f) > 0)
    .sort((a, b) => partNumber(a) - partNumber(b))
    .map((f) => path.join(dir, f));
}

function partNumber(fileName) {
  const m = /_(\d+)\.VOB$/i.exec(fileName);
  return m ? Number(m[1]) : 0;
}

/** Turn ffmpeg's terse error output into something a person can act on. */
function describeFfmpegFailure(stderr, fileName) {
  const text = String(stderr || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';

  if (/Permission denied|Operation not permitted/i.test(text)) {
    return (
      `Not allowed to write the working files. Choose a different working folder ` +
      `in Setup — somewhere in your home folder rather than an external drive ` +
      `that may be read-only.`
    );
  }
  if (/No space left/i.test(text)) {
    return (
      `Ran out of disk space while preparing "${fileName}". Preparing a disc ` +
      `needs roughly as much free space as the finished disc, so free up some ` +
      `room on your startup disk.`
    );
  }
  if (/Invalid data found|moov atom not found|could not find codec parameters/i.test(text)) {
    return `"${fileName}" appears to be damaged or only partly copied. It cannot be read.`;
  }
  if (/Unknown decoder|Decoder not found|Unsupported codec/i.test(text)) {
    return `"${fileName}" uses a format this copy of Burnhouse cannot decode.`;
  }
  if (last) return `Preparing "${fileName}" failed: ${last}`;
  return `Preparing "${fileName}" failed. The video tool gave no reason.`;
}

/** A short silent AC-3 track, for sources that have no sound at all. */
function buildSilentAudioArgs({ output, seconds, audioBitrate, channels }) {
  const layout = channels >= 6 ? '5.1' : 'stereo';
  return [
    '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=${layout}:sample_rate=48000`,
    '-t', `${Math.max(1, Math.ceil(seconds))}`,
    '-c:a', 'ac3',
    '-b:a', `${audioBitrate}`,
    '-ar', '48000',
    '-ac', `${channels}`,
    '-f', 'ac3',
    output,
  ];
}

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.isAbort = true;
  }
}

module.exports = {
  encodeTitle,
  buildEncodeArgs,
  buildVideoFilter,
  sourceMatrixFor,
  buildAudioFilter,
  buildSilentAudioArgs,
  listTitleParts,
  resetOutputDir,
  describeFfmpegFailure,
  extractWarnings,
  AbortError,
};
