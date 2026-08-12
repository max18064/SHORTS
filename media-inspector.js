import { stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_TEXT_LENGTH = 200;

function safeText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_TEXT_LENGTH) : null;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function frameRate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  const result = numerator / denominator;

  // A zero or nonsensical rate is not useful metadata.
  return Number.isFinite(result) && result > 0 ? Math.round(result * 1000) / 1000 : null;
}

function normalizeVideoStream(stream) {
  return {
    codec: safeText(stream?.codec_name),
    width: positiveInteger(stream?.width),
    height: positiveInteger(stream?.height),
    fps: frameRate(stream?.avg_frame_rate) ?? frameRate(stream?.r_frame_rate)
  };
}

function toInspectorError(prefix, error) {
  const detail = safeText(error?.message);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

/**
 * Read a media file's technical metadata without loading the file into memory.
 *
 * The returned object intentionally contains a small, normalized subset of the
 * FFprobe response. Raw FFprobe fields are not returned so callers do not need
 * to trust arbitrary metadata embedded in a media file.
 */
export async function inspectMediaFile(inputPath, { ffprobeBin = 'ffprobe' } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new TypeError('inputPath must be a non-empty file path.');
  }
  if (typeof ffprobeBin !== 'string' || !ffprobeBin.trim()) {
    throw new TypeError('ffprobeBin must be a non-empty executable path.');
  }

  const filePath = path.resolve(inputPath);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    throw toInspectorError(`Media file does not exist (${filePath})`, error);
  }

  if (fileStat.isDirectory()) {
    throw new Error(`Media path points to a directory, not a file: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`Media path is not a regular file: ${filePath}`);
  }

  let parsed;
  try {
    const { stdout } = await execFileAsync(ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    parsed = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`ffprobe returned invalid JSON for ${filePath}.`);
    }
    throw toInspectorError(`Unable to inspect media file with ffprobe (${filePath})`, error);
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStreams = streams.filter(stream => stream?.codec_type === 'video').map(normalizeVideoStream);
  const durationSeconds = nonNegativeNumber(parsed?.format?.duration)
    ?? nonNegativeNumber(streams.find(stream => stream?.codec_type === 'video')?.duration)
    ?? 0;

  return {
    filePath,
    fileName: path.basename(filePath),
    sizeBytes: fileStat.size,
    durationSeconds,
    format: {
      name: safeText(parsed?.format?.format_name),
      longName: safeText(parsed?.format?.format_long_name)
    },
    hasVideo: videoStreams.length > 0,
    video: videoStreams[0] ?? { codec: null, width: null, height: null, fps: null },
    videoStreams,
    hasAudio: streams.some(stream => stream?.codec_type === 'audio')
  };
}
