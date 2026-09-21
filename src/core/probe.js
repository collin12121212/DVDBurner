'use strict';

/**
 * Reading the facts out of a video file.
 *
 * The whole point of this module is that we ask ffprobe once, up front, and
 * then write down the answers. Everything downstream reads the recorded
 * numbers, so nothing ever re-guesses a duration or a frame rate mid-job.
 */

const { execFile } = require('child_process');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.mpg',
  '.mpeg', '.m2v', '.vob', '.ts', '.mts', '.m2ts', '.3gp', '.ogv', '.dv',
  '.divx', '.rm', '.rmvb', '.asf', '.f4v',
]);

// Files that already are DVD-Video assets and must not be treated as sources.
const DVD_ARTIFACT_EXTENSIONS = new Set(['.ifo', '.bup']);

function looksLikeVideo(filePath) {
  const lower = String(filePath).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = lower.slice(dot);
  if (DVD_ARTIFACT_EXTENSIONS.has(ext)) return false;
  return VIDEO_EXTENSIONS.has(ext);
}

function run(file, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || '');
          return reject(err);
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * Run ffprobe and return a normalised description.
 *
 * `fps` prefers the average frame rate, because a container's nominal `r_frame_rate`
 * is often the timebase rather than the real cadence, and a wrong frame rate is
 * what produces the classic out-of-sync burn.
 */
async function probeVideo(ffprobePath, filePath) {
  if (!ffprobePath) throw new Error('ffprobe is not available.');

  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-i', filePath,
  ];

  let raw;
  try {
    raw = await run(ffprobePath, args);
  } catch (err) {
    throw new Error(`Could not read "${filePath}": ${summariseProbeError(err)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Could not read "${filePath}": ffprobe returned unreadable output.`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audio = audioStreams[0] || null;

  const format = data.format || {};
  const duration =
    numberOrNull(format.duration) ??
    numberOrNull(video && video.duration) ??
    numberOrNull(audio && audio.duration);

  if (!video) {
    throw new Error(`"${basename(filePath)}" has no video track.`);
  }

  const fps = pickFrameRate(video);
  const width = numberOrNull(video.width);
  const height = numberOrNull(video.height);

  return {
    path: filePath,
    name: basename(filePath),
    duration: duration || 0,
    durationKnown: Boolean(duration && duration > 0),
    width: width || 0,
    height: height || 0,
    fps,
    interlaced: isInterlaced(video),
    videoCodec: video.codec_name || 'unknown',
    pixelFormat: video.pix_fmt || null,
    // Colour metadata, so the encoder can convert HD's BT.709 matrix to the
    // BT.601 matrix a DVD expects. Without this, HD sources come out with a
    // visible colour shift — reds go orange. Nulls mean "unknown", in which
    // case the encoder guesses from the resolution, the way players do.
    colorSpace: video.color_space || null,
    colorTransfer: video.color_transfer || null,
    colorPrimaries: video.color_primaries || null,
    hasAudio: Boolean(audio),
    audioCodec: audio ? audio.codec_name || 'unknown' : null,
    audioChannels: audio ? numberOrNull(audio.channels) || 2 : 0,
    audioChannelLayout: audio ? audio.channel_layout || null : null,
    audioSampleRate: audio ? numberOrNull(audio.sample_rate) : null,
    audioStreamCount: audioStreams.length,
    subtitleStreamCount: streams.filter((s) => s.codec_type === 'subtitle').length,
    sizeBytes: numberOrNull(format.size) || 0,
    bitrate: numberOrNull(format.bit_rate),
    formatName: format.format_name || null,
    warnings: buildWarnings({ video, audio, fps, width, height, duration, audioStreams }),
  };
}

function pickFrameRate(video) {
  const avg = parseRational(video.avg_frame_rate);
  const real = parseRational(video.r_frame_rate);
  // A very small or absurd average usually means ffprobe could not measure it.
  if (avg && avg > 1 && avg < 121) return round(avg, 3);
  if (real && real > 1 && real < 121) return round(real, 3);
  return 0;
}

function parseRational(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!text.includes('/')) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const [a, b] = text.split('/').map(Number);
  if (!b) return null;
  return a / b;
}

function isInterlaced(video) {
  const order = String(video.field_order || '').toLowerCase();
  return order === 'tt' || order === 'bb' || order === 'tb' || order === 'bt';
}

function buildWarnings({ video, audio, fps, width, height, duration, audioStreams }) {
  const out = [];

  if (!duration || duration <= 0) {
    out.push('Length could not be read. It will be measured during encoding.');
  }
  if (!fps) {
    out.push('Frame rate could not be read. 29.97 will be assumed.');
  }
  if (!width || !height) {
    out.push('Dimensions could not be read.');
  }
  if (!audio) {
    out.push('No sound track. A silent one will be added so the menu still works.');
  }
  if (audioStreams.length > 1) {
    out.push(
      `${audioStreams.length} sound tracks found. The first one will be used.`
    );
  }
  if (audio && String(audio.codec_name) === 'pcm_s16le' && audio.channel_layout === 'stereo') {
    // Fine, just noting CD-style audio is common in old captures.
  }
  if (/mpeg2video/.test(String(video.codec_name)) && width === 720 && (height === 480 || height === 576)) {
    out.push('Already DVD resolution. It will be re-wrapped without resizing.');
  }
  return out;
}

function summariseProbeError(err) {
  const stderr = String(err.stderr || err.message || '').trim();
  const lastMeaningful = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^ffprobe version|^configuration:|^lib(postproc|avutil|avcodec|avformat|avfilter|swscale|swresample)/.test(l))
    .pop();
  return lastMeaningful || 'the file could not be opened.';
}

function basename(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, places) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = {
  probeVideo,
  looksLikeVideo,
  VIDEO_EXTENSIONS,
};
