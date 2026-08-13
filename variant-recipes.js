import { createHash } from 'node:crypto';
import path from 'node:path';

// This module plans visible, editorial FFmpeg changes for media the operator
// owns.  A recipe deliberately records every render setting; it is not a
// fingerprinting, evasion, or hidden "uniqueness" mechanism.
export const EDITORIAL_RECIPE_SCHEMA_VERSION = 1;
export const MAX_EDITORIAL_CAMPAIGN_OUTPUTS = 500;

const MAX_PATH_LENGTH = 4_096;
const MAX_ID_LENGTH = 160;
const MAX_DIMENSION = 7_680;
const MAX_OVERLAY_MARGIN = 2_000;
const MAX_TEXT_LENGTH = 280;
const MAX_TEXT_SIZE = 512;
const MAX_TEXT_OUTLINE = 32;
const MAX_METADATA_TITLE_LENGTH = 200;
const MAX_METADATA_COMMENT_LENGTH = 500;
const MIN_PACE = 0.95;
const MAX_PACE = 1.05;
const AUDIO_MODES = new Set(['keep', 'mute', 'gain', 'mix']);
const OVERLAY_POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
const TEXT_POSITIONS = new Set([
  'top-left', 'top', 'top-center', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-center', 'bottom-right',
]);
const COLOR_CORRECTION_LEVELS = new Set(['off', 'weak', 'medium', 'strong']);
const FONT_EXTENSIONS = new Set(['.otf', '.ttf']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CROP_ASPECTS = Object.freeze({
  '1:1': { numerator: 1, denominator: 1 },
  '4:5': { numerator: 4, denominator: 5 },
  '9:16': { numerator: 9, denominator: 16 },
  '16:9': { numerator: 16, denominator: 9 },
});
const CROP_POSITIONS = new Set(['center', 'top', 'bottom', 'left', 'right']);
const SCALE_FITS = new Set(['contain', 'cover', 'stretch']);
const MUSIC_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);

// The public list contains only user-selectable deterministic presets.  The
// `user-list` value below is an explicit per-output mapping mode, not a
// preset that generates data on its own.
export const EDITORIAL_METADATA_PRESETS = Object.freeze([
  Object.freeze({
    id: 'clean',
    name: 'Clean export',
    description: 'Remove inherited container metadata and write no export fields.',
  }),
  Object.freeze({
    id: 'source-title',
    name: 'Source title',
    description: 'Use the source filename as the explicit export title.',
  }),
  Object.freeze({
    id: 'project-export',
    name: 'Project export',
    description: 'Use a deterministic Creator Flow export title and local-project comment.',
  }),
]);

const EDITORIAL_METADATA_PRESET_IDS = new Set([
  ...EDITORIAL_METADATA_PRESETS.map(preset => preset.id),
  'user-list',
]);

function recipeError(message, code = 'editorial-recipe-invalid') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function asPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw recipeError(`${label} must be an object.`);
  }
  return value;
}

function normalizedText(value, label, { required = false, maxLength = MAX_ID_LENGTH } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw recipeError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw recipeError(`${label} must be text.`);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!result && required) throw recipeError(`${label} is required.`);
  if (result.length > maxLength) throw recipeError(`${label} is too long.`);
  return result;
}

function normalizedPath(value, label, { extensions = null } = {}) {
  const rawPath = normalizedText(value, label, { required: true, maxLength: MAX_PATH_LENGTH });
  const result = path.resolve(rawPath);
  if (extensions) {
    const extension = path.extname(result).toLowerCase();
    if (!extensions.has(extension)) {
      throw recipeError(`${label} has an unsupported file extension.`);
    }
  }
  return result;
}

function normalizedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw recipeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizedNumber(value, label, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw recipeError(`${label} must be a number between ${min} and ${max}.`);
  }
  return Math.round(value * 10_000) / 10_000;
}

function normalizedHexColor(value, label, { defaultValue = undefined } = {}) {
  const rawValue = value === undefined || value === null || value === '' ? defaultValue : value;
  const color = normalizedText(rawValue, label, { required: true, maxLength: 7 });
  if (!HEX_COLOR.test(color)) {
    throw recipeError(`${label} must be a #RRGGBB color.`);
  }
  return color.toUpperCase();
}

function normalizedRange(value, label, { min = 0, max = 1 } = {}) {
  const range = asPlainObject(value, label);
  const minimum = normalizedNumber(range.min, `${label}.min`, { min, max });
  const maximum = normalizedNumber(range.max, `${label}.max`, { min, max });
  if (minimum > maximum) {
    throw recipeError(`${label}.min must not exceed ${label}.max.`);
  }
  return { min: minimum, max: maximum };
}

function normalizedEvenDimension(value, label) {
  const result = normalizedInteger(value, label, { min: 2, max: MAX_DIMENSION });
  if (result % 2 !== 0) throw recipeError(`${label} must be even for H.264 output.`);
  return result;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value, length = 24) {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, length);
}

function hashInteger(value) {
  return Number.parseInt(digest(value, 8), 16);
}

function decimal(value) {
  return String(Math.round(value * 10_000) / 10_000);
}

function positiveGain(value, label) {
  return normalizedNumber(value, label, { min: -24, max: 12 });
}

function normalizeSource(rawSource) {
  const source = asPlainObject(rawSource, 'source');
  const filePath = normalizedPath(source.filePath, 'source.filePath');
  const fallbackId = path.basename(filePath);
  const id = normalizedText(source.id ?? fallbackId, 'source.id', { required: true, maxLength: MAX_ID_LENGTH });
  if (source.hasAudio !== undefined && typeof source.hasAudio !== 'boolean') {
    throw recipeError('source.hasAudio must be a boolean when supplied.');
  }

  return {
    id,
    filePath,
    hasAudio: source.hasAudio ?? null,
  };
}

function normalizeCrop(rawCrop) {
  if (rawCrop === undefined || rawCrop === null || rawCrop === false) return null;
  const crop = asPlainObject(rawCrop, 'edits.crop');
  const aspect = normalizedText(crop.aspect, 'edits.crop.aspect', { required: true, maxLength: 12 });
  if (!CROP_ASPECTS[aspect]) throw recipeError('edits.crop.aspect is not supported.');
  const position = normalizedText(crop.position ?? 'center', 'edits.crop.position', { required: true, maxLength: 20 });
  if (!CROP_POSITIONS.has(position)) throw recipeError('edits.crop.position is not supported.');
  return { aspect, position };
}

function normalizeScale(rawScale) {
  if (rawScale === undefined || rawScale === null || rawScale === false) return null;
  const scale = asPlainObject(rawScale, 'edits.scale');
  const fit = normalizedText(scale.fit ?? 'contain', 'edits.scale.fit', { required: true, maxLength: 20 });
  if (!SCALE_FITS.has(fit)) throw recipeError('edits.scale.fit is not supported.');
  return {
    width: normalizedEvenDimension(scale.width, 'edits.scale.width'),
    height: normalizedEvenDimension(scale.height, 'edits.scale.height'),
    fit,
  };
}

function resolveBoundedValue(bounds, variationSeed, label) {
  if (bounds.min === bounds.max) return bounds.min;
  // The seed is an explicit recipe identity, not a device/browser value. This
  // keeps each output reproducible and makes the chosen setting auditable.
  const unit = hashInteger({ kind: 'editorial-bounded-value', label, variationSeed, bounds }) / 0xffffffff;
  return Math.round((bounds.min + ((bounds.max - bounds.min) * unit)) * 10_000) / 10_000;
}

function normalizeOptionalBlur(rawBlur, rawBounds, variationSeed) {
  if (rawBlur === undefined || rawBlur === null || rawBlur === '') {
    if (rawBounds !== undefined) {
      throw recipeError('edits.overlay.blur must be present when edits.overlay.blurBounds is supplied.');
    }
    return {};
  }

  const isRange = rawBlur && typeof rawBlur === 'object' && !Array.isArray(rawBlur);
  if (isRange && rawBounds !== undefined) {
    throw recipeError('Use either edits.overlay.blur as a range or blurBounds with a resolved blur value.');
  }
  if (isRange) {
    const blurBounds = normalizedRange(rawBlur, 'edits.overlay.blur', { min: 0, max: 1 });
    return {
      blur: resolveBoundedValue(blurBounds, variationSeed, 'overlay.blur'),
      blurBounds,
    };
  }

  const blur = normalizedNumber(rawBlur, 'edits.overlay.blur', { min: 0, max: 1 });
  if (rawBounds === undefined || rawBounds === null || rawBounds === '') return { blur };
  const blurBounds = normalizedRange(rawBounds, 'edits.overlay.blurBounds', { min: 0, max: 1 });
  if (blur < blurBounds.min || blur > blurBounds.max) {
    throw recipeError('edits.overlay.blur must stay within edits.overlay.blurBounds.');
  }
  return { blur, blurBounds };
}

function normalizeOverlay(rawOverlay, variationSeed) {
  if (rawOverlay === undefined || rawOverlay === null || rawOverlay === false) return null;
  const overlay = asPlainObject(rawOverlay, 'edits.overlay');
  const position = normalizedText(overlay.position ?? 'bottom-right', 'edits.overlay.position', { required: true, maxLength: 24 });
  if (!OVERLAY_POSITIONS.has(position)) throw recipeError('edits.overlay.position is not supported.');
  const normalized = {
    filePath: normalizedPath(overlay.filePath, 'edits.overlay.filePath', { extensions: new Set(['.png']) }),
    position,
    opacity: normalizedNumber(overlay.opacity ?? 1, 'edits.overlay.opacity', { min: 0.05, max: 1 }),
    width: normalizedEvenDimension(overlay.width, 'edits.overlay.width'),
    margin: normalizedInteger(overlay.margin ?? 24, 'edits.overlay.margin', { min: 0, max: MAX_OVERLAY_MARGIN }),
  };
  return { ...normalized, ...normalizeOptionalBlur(overlay.blur, overlay.blurBounds, variationSeed) };
}

function normalizeTextOutline(rawOutline) {
  if (rawOutline === undefined || rawOutline === null || rawOutline === false) return null;
  if (rawOutline === true) return { color: '#000000', width: 3 };
  const outline = asPlainObject(rawOutline, 'edits.text.outline');
  return {
    color: normalizedHexColor(outline.color, 'edits.text.outline.color', { defaultValue: '#000000' }),
    width: normalizedInteger(outline.width ?? 3, 'edits.text.outline.width', { min: 1, max: MAX_TEXT_OUTLINE }),
  };
}

function normalizeText(rawText) {
  if (rawText === undefined || rawText === null || rawText === false) return null;
  const text = asPlainObject(rawText, 'edits.text');
  if (text.value !== undefined && text.text !== undefined && text.value !== text.text) {
    throw recipeError('Use only one of edits.text.value or edits.text.text.');
  }
  const value = normalizedText(text.value ?? text.text, 'edits.text.value', { required: true, maxLength: MAX_TEXT_LENGTH });
  const position = normalizedText(text.position ?? 'bottom-center', 'edits.text.position', { required: true, maxLength: 24 });
  if (!TEXT_POSITIONS.has(position)) throw recipeError('edits.text.position is not supported.');
  const normalized = {
    value,
    fontFile: normalizedPath(text.fontFile, 'edits.text.fontFile', { extensions: FONT_EXTENSIONS }),
    size: normalizedInteger(text.size, 'edits.text.size', { min: 8, max: MAX_TEXT_SIZE }),
    position,
    color: normalizedHexColor(text.color, 'edits.text.color', { defaultValue: '#FFFFFF' }),
    outline: normalizeTextOutline(text.outline),
    margin: normalizedInteger(text.margin ?? 48, 'edits.text.margin', { min: 0, max: MAX_OVERLAY_MARGIN }),
  };
  if (text.yPercent !== undefined && text.yPercent !== null && text.yPercent !== '') {
    normalized.yPercent = normalizedNumber(text.yPercent, 'edits.text.yPercent', { min: 5, max: 95 });
  }
  return normalized;
}

function normalizeColor(rawColor) {
  if (rawColor === undefined || rawColor === null || rawColor === '') return null;
  if (typeof rawColor === 'string') {
    const level = normalizedText(rawColor, 'edits.color', { required: true, maxLength: 12 });
    if (!COLOR_CORRECTION_LEVELS.has(level)) throw recipeError('edits.color is not supported.');
    return level === 'off' ? null : level;
  }
  const color = asPlainObject(rawColor, 'edits.color');
  const level = normalizedText(color.level ?? 'medium', 'edits.color.level', { required: true, maxLength: 12 });
  if (!COLOR_CORRECTION_LEVELS.has(level)) throw recipeError('edits.color is not supported.');
  if (level === 'off') return null;
  return {
    level,
    // A slider value is kept verbatim in the recipe and scales the declared
    // correction below.  It is an editorial control, never a hidden change.
    amount: normalizedNumber(color.amount ?? 100, 'edits.color.amount', { min: 0, max: 100 }),
  };
}

function normalizeVideo(rawVideo) {
  if (rawVideo === undefined || rawVideo === null || rawVideo === false) return null;
  const video = asPlainObject(rawVideo, 'edits.video');
  const result = {};
  if (video.fps !== undefined && video.fps !== null && video.fps !== '') {
    result.fps = normalizedInteger(video.fps, 'edits.video.fps', { min: 12, max: 120 });
  }
  if (video.bitrateKbps !== undefined && video.bitrateKbps !== null && video.bitrateKbps !== '') {
    result.bitrateKbps = normalizedInteger(video.bitrateKbps, 'edits.video.bitrateKbps', { min: 100, max: 100_000 });
  }
  if (video.quality !== undefined && video.quality !== null && video.quality !== '') {
    const quality = normalizedText(video.quality, 'edits.video.quality', { required: true, maxLength: 16 });
    if (!new Set(['low', 'medium', 'high']).has(quality)) {
      throw recipeError('edits.video.quality is not supported.');
    }
    result.quality = quality;
  }
  if (result.bitrateKbps && result.quality) {
    throw recipeError('Use edits.video.bitrateKbps or edits.video.quality, not both.');
  }
  return Object.keys(result).length ? result : null;
}

function normalizeMetadataPresetId(value, label = 'edits.metadata.presetId') {
  const presetId = normalizedText(value, label, { required: true, maxLength: 32 }).toLowerCase();
  if (!EDITORIAL_METADATA_PRESET_IDS.has(presetId)) {
    throw recipeError(`${label} is not supported.`, 'editorial-metadata-preset-invalid');
  }
  return presetId;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeMetadataText(value, label, maxLength) {
  return normalizedText(value, label, { required: true, maxLength });
}

function normalizeMetadata(rawMetadata) {
  if (rawMetadata === undefined || rawMetadata === null) return null;
  const metadata = asPlainObject(rawMetadata, 'edits.metadata');
  const allowedKeys = new Set(['presetId', 'title', 'comment']);
  for (const key of Object.keys(metadata)) {
    if (!allowedKeys.has(key)) {
      throw recipeError(`edits.metadata.${key} is not allowed.`, 'editorial-metadata-field-invalid');
    }
  }

  const presetId = normalizeMetadataPresetId(metadata.presetId);
  const hasTitle = hasOwn(metadata, 'title');
  const hasComment = hasOwn(metadata, 'comment');
  if (presetId === 'clean') {
    if (hasTitle || hasComment) {
      throw recipeError('edits.metadata.clean must not contain title or comment.', 'editorial-metadata-field-invalid');
    }
    return { presetId };
  }

  // Named metadata presets resolve to both explicit fields.  User-list is a
  // transparent override mode: it never invents a title or comment, and must
  // have an operator-supplied title for each mapped output.
  if (!hasTitle) {
    throw recipeError(`edits.metadata.${presetId} requires an explicit title.`, 'editorial-metadata-field-invalid');
  }
  const normalized = {
    presetId,
    title: normalizeMetadataText(metadata.title, 'edits.metadata.title', MAX_METADATA_TITLE_LENGTH),
  };
  if (hasComment) {
    normalized.comment = normalizeMetadataText(metadata.comment, 'edits.metadata.comment', MAX_METADATA_COMMENT_LENGTH);
  } else if (presetId !== 'user-list') {
    throw recipeError(`edits.metadata.${presetId} requires an explicit comment.`, 'editorial-metadata-field-invalid');
  }
  return normalized;
}

function metadataSourceTitle(source) {
  const extension = path.extname(source.filePath);
  const baseName = path.basename(source.filePath, extension) || path.basename(source.filePath);
  return normalizeMetadataText(baseName, 'source filename title', MAX_METADATA_TITLE_LENGTH);
}

/**
 * Return public metadata preset information for a UI selector.  `user-list`
 * is deliberately omitted: it is only a per-output explicit mapping mode.
 */
export function listEditorialMetadataPresets() {
  return EDITORIAL_METADATA_PRESETS.map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * Resolve a metadata selector into the exact fields that will be written into
 * an export.  It uses no dates, device values, encoder tags, IDs, or random
 * data.  `user-list` is accepted only with a caller-provided title (and an
 * optional caller-provided comment), so it cannot generate any values by
 * itself.
 */
export function resolveEditorialMetadataPreset({
  presetId = 'clean',
  source,
  campaignId = '',
  variantIndex = 1,
  title,
  comment,
} = {}) {
  const normalizedSource = normalizeSource(source);
  // Keep input validation and call shape consistent with other deterministic
  // resolvers, even though campaignId does not participate in the permitted
  // export fields.
  normalizedText(campaignId, 'campaignId', { maxLength: MAX_ID_LENGTH });
  const normalizedVariantIndex = normalizedInteger(variantIndex, 'variantIndex', {
    min: 1,
    max: MAX_EDITORIAL_CAMPAIGN_OUTPUTS,
  });
  const normalizedPresetId = normalizeMetadataPresetId(presetId, 'presetId');
  if (normalizedPresetId === 'clean') return normalizeMetadata({ presetId: 'clean' });
  if (normalizedPresetId === 'source-title') {
    return normalizeMetadata({
      presetId: normalizedPresetId,
      title: title === undefined
        ? metadataSourceTitle(normalizedSource)
        : normalizeMetadataText(title, 'title', MAX_METADATA_TITLE_LENGTH),
      comment: 'Local Creator Flow export',
    });
  }
  if (normalizedPresetId === 'project-export') {
    return normalizeMetadata({
      presetId: normalizedPresetId,
      title: `Creator Flow export ${normalizedVariantIndex}`,
      comment: 'Local project export',
    });
  }
  const explicit = { presetId: normalizedPresetId };
  if (title !== undefined) explicit.title = title;
  if (comment !== undefined) explicit.comment = comment;
  return normalizeMetadata(explicit);
}

function normalizeAudio(rawAudio, source, pace) {
  const input = rawAudio === undefined || rawAudio === null ? {} : asPlainObject(rawAudio, 'edits.audio');
  const mode = normalizedText(input.mode ?? 'keep', 'edits.audio.mode', { required: true, maxLength: 20 });
  if (!AUDIO_MODES.has(mode)) throw recipeError('edits.audio.mode is not supported.');

  if (mode === 'mute') return { mode: 'mute' };
  if ((mode === 'gain' || mode === 'mix') && source.hasAudio !== true) {
    throw recipeError(`edits.audio.mode=${mode} requires source.hasAudio=true.`);
  }
  if (pace !== 1 && source.hasAudio === null) {
    throw recipeError('source.hasAudio must be known when pacing audio is requested.');
  }

  if (mode === 'keep') return { mode: 'keep' };
  if (mode === 'gain') return { mode: 'gain', gainDb: positiveGain(input.gainDb ?? 0, 'edits.audio.gainDb') };

  return {
    mode: 'mix',
    musicPath: normalizedPath(input.musicPath, 'edits.audio.musicPath', { extensions: MUSIC_EXTENSIONS }),
    sourceGainDb: positiveGain(input.sourceGainDb ?? 0, 'edits.audio.sourceGainDb'),
    musicGainDb: positiveGain(input.musicGainDb ?? -16, 'edits.audio.musicGainDb'),
  };
}

/**
 * Validate and normalize visible editorial edits.  All returned values are
 * explicit, so they can be shown in a UI and stored in a job manifest.
 */
export function normalizeEditorialEdits(rawEdits = {}, { source, variationSeed = { kind: 'direct-editorial-edits' } } = {}) {
  const edits = asPlainObject(rawEdits, 'edits');
  const normalizedSource = source ? normalizeSource(source) : null;
  const pace = normalizedNumber(edits.pace ?? 1, 'edits.pace', { min: MIN_PACE, max: MAX_PACE });
  if (!normalizedSource && (edits.audio?.mode === 'gain' || edits.audio?.mode === 'mix' || pace !== 1)) {
    throw recipeError('A source with hasAudio is required to validate these audio edits.');
  }

  const normalized = {
    crop: normalizeCrop(edits.crop),
    scale: normalizeScale(edits.scale),
    overlay: normalizeOverlay(edits.overlay, variationSeed),
    pace,
    audio: normalizeAudio(edits.audio, normalizedSource || { hasAudio: null }, pace),
  };
  const text = normalizeText(edits.text);
  const color = normalizeColor(edits.color);
  const video = normalizeVideo(edits.video);
  const metadata = normalizeMetadata(edits.metadata);
  // Omit inactive new fields.  This preserves the signed form of recipes
  // created before these optional controls existed.
  if (text) normalized.text = text;
  if (color) normalized.color = color;
  if (video) normalized.video = video;
  if (metadata) normalized.metadata = metadata;
  return normalized;
}

function materialChanges(edits) {
  const changes = ['re-encode-h264-aac', 'strip-container-metadata'];
  if (edits.crop) changes.push(`crop-${edits.crop.aspect}-${edits.crop.position}`);
  if (edits.scale) changes.push(`scale-${edits.scale.width}x${edits.scale.height}-${edits.scale.fit}`);
  if (edits.overlay) changes.push(`overlay-${edits.overlay.position}-${Math.round(edits.overlay.opacity * 100)}pct`);
  if (edits.overlay?.blur > 0) changes.push(`overlay-blur-${decimal(edits.overlay.blur)}`);
  if (edits.text) changes.push(`text-${edits.text.position}-${edits.text.size}px`);
  if (edits.color) {
    const colorLevel = typeof edits.color === 'string' ? edits.color : edits.color.level;
    const colorAmount = typeof edits.color === 'string' ? null : edits.color.amount;
    changes.push(colorAmount === null ? `color-${colorLevel}` : `color-${colorLevel}-${decimal(colorAmount)}pct`);
  }
  if (edits.video?.fps) changes.push(`fps-${edits.video.fps}`);
  if (edits.video?.bitrateKbps) changes.push(`bitrate-${edits.video.bitrateKbps}k`);
  if (edits.video?.quality) changes.push(`quality-${edits.video.quality}`);
  if (edits.metadata) changes.push(`metadata-${edits.metadata.presetId}`);
  if (edits.pace !== 1) changes.push(`pace-${decimal(edits.pace)}x`);
  if (edits.audio.mode === 'mute') changes.push('audio-muted');
  if (edits.audio.mode === 'gain') changes.push(`audio-gain-${decimal(edits.audio.gainDb)}db`);
  if (edits.audio.mode === 'mix') changes.push('audio-mix');
  return changes;
}

function recipeIdentity({ source, campaignId, variantIndex, profileId, edits }) {
  return {
    schemaVersion: EDITORIAL_RECIPE_SCHEMA_VERSION,
    kind: 'editorial-media-version',
    source,
    campaignId,
    variantIndex,
    profileId,
    edits,
    metadata: { mode: 'strip-technical' },
  };
}

/**
 * Build one deterministic recipe.  The same normalized input always yields
 * the same recipeId and renderSignature.  `variantIndex` is recorded for
 * traceability; the renderSignature intentionally excludes it so a caller can
 * spot duplicated render settings instead of calling them "unique".
 */
export function createEditorialRecipe({ source, campaignId = '', variantIndex = 1, profileId = 'default', edits = {} } = {}) {
  const normalizedSource = normalizeSource(source);
  const normalizedCampaignId = normalizedText(campaignId, 'campaignId', { maxLength: MAX_ID_LENGTH });
  const normalizedVariantIndex = normalizedInteger(variantIndex, 'variantIndex', { min: 1, max: MAX_EDITORIAL_CAMPAIGN_OUTPUTS });
  const normalizedProfileId = normalizedText(profileId, 'profileId', { required: true, maxLength: MAX_ID_LENGTH });
  const normalizedEdits = normalizeEditorialEdits(edits, {
    source: normalizedSource,
    variationSeed: {
      campaignId: normalizedCampaignId,
      sourceId: normalizedSource.id,
      sourcePath: normalizedSource.filePath,
      variantIndex: normalizedVariantIndex,
      profileId: normalizedProfileId,
    },
  });
  const identity = recipeIdentity({
    source: normalizedSource,
    campaignId: normalizedCampaignId,
    variantIndex: normalizedVariantIndex,
    profileId: normalizedProfileId,
    edits: normalizedEdits,
  });
  const renderIdentity = {
    kind: identity.kind,
    source: identity.source,
    edits: identity.edits,
    metadata: identity.metadata,
  };

  return {
    ...identity,
    recipeId: `edr-${digest(identity)}`,
    renderSignature: `render-${digest(renderIdentity)}`,
    materialChanges: materialChanges(normalizedEdits),
  };
}

// Public preset labels intentionally contain no rendering settings.  The
// concrete settings are resolved below for a particular output, then saved in
// its recipe where an operator can inspect them.  A preset is therefore a
// repeatable editorial starting point, not an opaque "uniqueness" switch.
export const EDITORIAL_PRESETS = Object.freeze([
  Object.freeze({
    id: 'manual',
    name: 'Ручной режим',
    description: 'Оставляет выбранные параметры обработки без пресета.',
  }),
  Object.freeze({
    id: 'shorts-balanced',
    name: 'Shorts — сбалансированный',
    description: 'Вертикальный 9:16 с умеренными открытыми изменениями темпа, цвета и кодирования.',
  }),
  Object.freeze({
    id: 'soft-editorial',
    name: 'Мягкий монтаж',
    description: 'Кадр 4:5 с мягкой цветокоррекцией и спокойным темпом.',
  }),
  Object.freeze({
    id: 'square-stories',
    name: 'Квадратные истории',
    description: 'Кадр 1:1 для ленты с явными изменениями темпа, цвета и FPS.',
  }),
]);

const EDITORIAL_PRESET_IDS = new Set(EDITORIAL_PRESETS.map(preset => preset.id));

/**
 * Return lightweight preset information suitable for a selector in the UI.
 * A fresh object is returned for every item so callers cannot mutate the
 * exported preset catalogue.
 */
export function listEditorialPresets() {
  return EDITORIAL_PRESETS.map(({ id, name, description }) => ({ id, name, description }));
}

function normalizePresetId(value) {
  const presetId = normalizedText(value ?? '', 'presetId', { maxLength: 64 }).toLowerCase();
  if (!presetId || presetId === 'manual') return 'manual';
  if (!EDITORIAL_PRESET_IDS.has(presetId)) {
    throw recipeError('presetId is not supported.', 'editorial-preset-invalid');
  }
  return presetId;
}

function resolvePresetContext({ source, campaignId = '', variantIndex = 1, profileId = 'default' } = {}) {
  const normalizedSource = normalizeSource(source);
  const normalizedCampaignId = normalizedText(campaignId, 'campaignId', { maxLength: MAX_ID_LENGTH });
  const normalizedVariantIndex = normalizedInteger(variantIndex, 'variantIndex', {
    min: 1,
    max: MAX_EDITORIAL_CAMPAIGN_OUTPUTS,
  });
  const normalizedProfileId = normalizedText(profileId, 'profileId', {
    required: true,
    maxLength: MAX_ID_LENGTH,
  });
  return {
    source: normalizedSource,
    campaignId: normalizedCampaignId,
    variantIndex: normalizedVariantIndex,
    profileId: normalizedProfileId,
    variationSeed: {
      campaignId: normalizedCampaignId,
      sourceId: normalizedSource.id,
      sourcePath: normalizedSource.filePath,
      variantIndex: normalizedVariantIndex,
      profileId: normalizedProfileId,
    },
  };
}

function presetSlot(context, presetId, count) {
  const offset = hashInteger({
    kind: 'editorial-preset-slot',
    presetId,
    campaignId: context.campaignId,
    sourceId: context.source.id,
    profileId: context.profileId,
  }) % count;
  // 137 is coprime with the 500-output campaign limit, so the first 500
  // variant indexes visit every available slot exactly once.
  return ((context.variantIndex - 1) * 137 + offset) % count;
}

function presetPace(context, presetId, { min, max }) {
  const slots = MAX_EDITORIAL_CAMPAIGN_OUTPUTS;
  const slot = presetSlot(context, presetId, slots);
  return Math.round((min + ((max - min) * (slot / (slots - 1)))) * 10_000) / 10_000;
}

function presetChoice(context, presetId, name, values) {
  const offset = hashInteger({
    kind: 'editorial-preset-choice',
    presetId,
    name,
    campaignId: context.campaignId,
    sourceId: context.source.id,
    profileId: context.profileId,
  }) % values.length;
  return values[(context.variantIndex - 1 + offset) % values.length];
}

function presetCoreEdits(context, presetId) {
  if (presetId === 'shorts-balanced') {
    const color = presetChoice(context, presetId, 'color', [
      { level: 'weak', amount: 58 },
      { level: 'medium', amount: 64 },
      { level: 'medium', amount: 72 },
    ]);
    return {
      crop: { aspect: '9:16', position: 'center' },
      scale: { width: 1080, height: 1920, fit: 'cover' },
      pace: presetPace(context, presetId, { min: 0.955, max: 1.045 }),
      color,
      video: {
        fps: presetChoice(context, presetId, 'fps', [24, 25, 30]),
        bitrateKbps: presetChoice(context, presetId, 'bitrate', [2600, 3000, 3400, 3800]),
      },
    };
  }

  if (presetId === 'soft-editorial') {
    const color = presetChoice(context, presetId, 'color', [
      { level: 'weak', amount: 38 },
      { level: 'weak', amount: 48 },
      { level: 'medium', amount: 52 },
    ]);
    return {
      crop: { aspect: '4:5', position: 'center' },
      scale: { width: 1080, height: 1350, fit: 'cover' },
      pace: presetPace(context, presetId, { min: 0.965, max: 1.035 }),
      color,
      video: {
        fps: presetChoice(context, presetId, 'fps', [24, 25, 30]),
        bitrateKbps: presetChoice(context, presetId, 'bitrate', [2400, 2800, 3200]),
      },
    };
  }

  if (presetId === 'square-stories') {
    const color = presetChoice(context, presetId, 'color', [
      { level: 'weak', amount: 50 },
      { level: 'medium', amount: 58 },
      { level: 'medium', amount: 68 },
    ]);
    return {
      crop: { aspect: '1:1', position: 'center' },
      scale: { width: 1080, height: 1080, fit: 'cover' },
      pace: presetPace(context, presetId, { min: 0.96, max: 1.04 }),
      color,
      video: {
        fps: presetChoice(context, presetId, 'fps', [24, 25, 30]),
        bitrateKbps: presetChoice(context, presetId, 'bitrate', [2200, 2600, 3000, 3400]),
      },
    };
  }

  throw recipeError('presetId is not supported.', 'editorial-preset-invalid');
}

/**
 * Resolve a named preset into the explicit edits used by one output recipe.
 *
 * `overlay`, `text`, and `audio` always come from `baseEdits`; presets never
 * invent visual captions, files, audio, metadata, device values, or hidden
 * content.  The three named presets intentionally own crop/scale/pace/color
 * and video encoding so every output has an inspectable, deterministic set of
 * visible editorial settings.  `manual`, an omitted ID, and an empty ID only
 * validate and normalize `baseEdits` without adding preset changes.
 */
export function resolveEditorialPreset({
  presetId = 'manual',
  baseEdits = {},
  source,
  campaignId = '',
  variantIndex = 1,
  profileId = 'default',
} = {}) {
  const context = resolvePresetContext({ source, campaignId, variantIndex, profileId });
  const normalizedPresetId = normalizePresetId(presetId);
  const rawBaseEdits = baseEdits ?? {};
  asPlainObject(rawBaseEdits, 'baseEdits');
  const rawEdits = normalizedPresetId === 'manual'
    ? rawBaseEdits
    : { ...rawBaseEdits, ...presetCoreEdits(context, normalizedPresetId) };
  return normalizeEditorialEdits(rawEdits, {
    source: context.source,
    variationSeed: context.variationSeed,
  });
}

function normalizeProfile(rawProfile, index) {
  const profile = asPlainObject(rawProfile, `profiles[${index}]`);
  return {
    id: normalizedText(profile.id ?? `profile-${index + 1}`, `profiles[${index}].id`, { required: true, maxLength: MAX_ID_LENGTH }),
    edits: asPlainObject(profile.edits ?? {}, `profiles[${index}].edits`),
  };
}

function assertRecipeMatchesIdentity(recipe) {
  const normalized = createEditorialRecipe({
    source: recipe?.source,
    campaignId: recipe?.campaignId,
    variantIndex: recipe?.variantIndex,
    profileId: recipe?.profileId,
    edits: recipe?.edits,
  });
  if (recipe?.recipeId && recipe.recipeId !== normalized.recipeId) {
    throw recipeError('recipeId does not match the recipe content.', 'editorial-recipe-tampered');
  }
  if (recipe?.renderSignature && recipe.renderSignature !== normalized.renderSignature) {
    throw recipeError('renderSignature does not match the recipe content.', 'editorial-recipe-tampered');
  }
  return normalized;
}

/**
 * Plan a bounded campaign of explicit output recipes.  Sources are assigned in
 * round-robin order; a stable hash chooses a named profile for each output.
 * The returned duplicateRenderGroups makes identical settings visible.
 */
export function createEditorialCampaignPlan({ sources, outputCount, campaignId = '', profiles = [{ id: 'normalized', edits: {} }] } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw recipeError('sources must be a non-empty array.');
  }
  if (sources.length > MAX_EDITORIAL_CAMPAIGN_OUTPUTS) {
    throw recipeError(`sources cannot exceed ${MAX_EDITORIAL_CAMPAIGN_OUTPUTS}.`);
  }
  const normalizedSources = sources.map(normalizeSource);
  const duplicateSourceIds = normalizedSources.map(source => source.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateSourceIds.length) throw recipeError('source.id values must be unique within one plan.');
  const normalizedOutputCount = normalizedInteger(outputCount, 'outputCount', { min: 1, max: MAX_EDITORIAL_CAMPAIGN_OUTPUTS });
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 64) {
    throw recipeError('profiles must contain between 1 and 64 named editorial profiles.');
  }
  const normalizedProfiles = profiles.map(normalizeProfile);
  const duplicateProfileIds = normalizedProfiles.map(profile => profile.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateProfileIds.length) throw recipeError('profiles[].id values must be unique within one plan.');
  const normalizedCampaignId = normalizedText(campaignId, 'campaignId', { maxLength: MAX_ID_LENGTH });
  const recipes = [];

  for (let outputIndex = 0; outputIndex < normalizedOutputCount; outputIndex += 1) {
    const sourceIndex = outputIndex % normalizedSources.length;
    const variantIndex = Math.floor(outputIndex / normalizedSources.length) + 1;
    const source = normalizedSources[sourceIndex];
    const profileIndex = hashInteger({ campaignId: normalizedCampaignId, sourceId: source.id, variantIndex }) % normalizedProfiles.length;
    const profile = normalizedProfiles[profileIndex];
    const recipe = createEditorialRecipe({
      source,
      campaignId: normalizedCampaignId,
      variantIndex,
      profileId: profile.id,
      edits: profile.edits,
    });
    recipes.push({ outputIndex: outputIndex + 1, sourceIndex: sourceIndex + 1, ...recipe });
  }

  const signatureGroups = new Map();
  for (const recipe of recipes) {
    const group = signatureGroups.get(recipe.renderSignature) || [];
    group.push(recipe.outputIndex);
    signatureGroups.set(recipe.renderSignature, group);
  }
  const duplicateRenderGroups = [...signatureGroups.entries()]
    .filter(([, outputIndexes]) => outputIndexes.length > 1)
    .map(([renderSignature, outputIndexes]) => ({ renderSignature, outputIndexes }));

  return {
    schemaVersion: EDITORIAL_RECIPE_SCHEMA_VERSION,
    kind: 'editorial-campaign-plan',
    campaignId: normalizedCampaignId,
    outputCount: normalizedOutputCount,
    sourceCount: normalizedSources.length,
    profiles: normalizedProfiles.map(profile => ({ id: profile.id })),
    recipes,
    duplicateRenderGroups,
  };
}

function cropFilter(crop) {
  const ratio = CROP_ASPECTS[crop.aspect];
  const target = decimal(ratio.numerator / ratio.denominator);
  // Keep chroma dimensions even before an H.264/yuv420p encode.  This is an
  // explicit compatibility requirement, not a hidden render change.
  const width = `trunc(min(iw\\,ih*${target})/2)*2`;
  const height = `trunc(min(ih\\,iw/${target})/2)*2`;
  const x = crop.position === 'left' ? '0'
    : crop.position === 'right' ? '(iw-ow)'
      : '(iw-ow)/2';
  const y = crop.position === 'top' ? '0'
    : crop.position === 'bottom' ? '(ih-oh)'
      : '(ih-oh)/2';
  return `crop=w='${width}':h='${height}':x='${x}':y='${y}'`;
}

function scaleFilter(scale) {
  const dimensions = `w=${scale.width}:h=${scale.height}`;
  if (scale.fit === 'stretch') return `scale=${dimensions}`;
  if (scale.fit === 'contain') {
    return `scale=${dimensions}:force_original_aspect_ratio=decrease,pad=${scale.width}:${scale.height}:(ow-iw)/2:(oh-ih)/2`;
  }
  return `scale=${dimensions}:force_original_aspect_ratio=increase,crop=${scale.width}:${scale.height}`;
}

function overlayCoordinates(position, margin) {
  const edgeX = `main_w-overlay_w-${margin}`;
  const edgeY = `main_h-overlay_h-${margin}`;
  switch (position) {
    case 'top-left': return `${margin}:${margin}`;
    case 'top-right': return `${edgeX}:${margin}`;
    case 'bottom-left': return `${margin}:${edgeY}`;
    case 'bottom-right': return `${edgeX}:${edgeY}`;
    case 'center': return '(main_w-overlay_w)/2:(main_h-overlay_h)/2';
    default: throw recipeError('Unsupported overlay position.');
  }
}

function textCoordinates(position, margin) {
  const centeredX = '(w-text_w)/2';
  const centeredY = '(h-text_h)/2';
  const rightX = `w-text_w-${margin}`;
  const bottomY = `h-text_h-${margin}`;
  switch (position) {
    case 'top-left': return [String(margin), String(margin)];
    case 'top':
    case 'top-center': return [centeredX, String(margin)];
    case 'top-right': return [rightX, String(margin)];
    case 'left': return [String(margin), centeredY];
    case 'center': return [centeredX, centeredY];
    case 'right': return [rightX, centeredY];
    case 'bottom-left': return [String(margin), bottomY];
    case 'bottom':
    case 'bottom-center': return [centeredX, bottomY];
    case 'bottom-right': return [rightX, bottomY];
    default: throw recipeError('Unsupported text position.');
  }
}

function escapeFilterValue(value) {
  // Escaping is for FFmpeg's filtergraph parser only.  `buildFfmpegArgs`
  // returns argv for execFile(), so no input here is ever interpreted by a
  // command shell.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function escapeDrawtextFontPath(value) {
  // On Windows drawtext parses a drive colon as an option separator.  Forward
  // slashes make the path unambiguous to FFmpeg, then the drive colon is
  // escaped exactly once for the filter parser.  Text itself still uses the
  // broader escaping above because a backslash can be visible content there.
  return String(value)
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function drawtextFilter(text) {
  const outline = text.outline
    ? `:borderw=${text.outline.width}:bordercolor=0x${text.outline.color.slice(1)}`
    : '';
  const [x, fallbackY] = textCoordinates(text.position, text.margin);
  const y = text.yPercent === undefined
    ? fallbackY
    : `h*${decimal(text.yPercent / 100)}-text_h/2`;
  return `drawtext=fontfile='${escapeDrawtextFontPath(text.fontFile)}':text='${escapeFilterValue(text.value)}':expansion=none:fontsize=${text.size}:fontcolor=0x${text.color.slice(1)}${outline}:x=${x}:y=${y}`;
}

function colorCorrectionFilter(color) {
  const level = typeof color === 'string' ? color : color.level;
  const amount = typeof color === 'string' ? 100 : color.amount;
  const presets = {
    weak: { contrast: 0.03, brightness: 0.005, saturation: 0.04, gamma: 0.01 },
    medium: { contrast: 0.07, brightness: 0.01, saturation: 0.09, gamma: 0.03 },
    strong: { contrast: 0.12, brightness: 0.015, saturation: 0.15, gamma: 0.05 },
  };
  const preset = presets[level];
  if (!preset) throw recipeError('Unsupported color correction level.');
  const multiplier = amount / 100;
  return `eq=contrast=${decimal(1 + (preset.contrast * multiplier))}:brightness=${decimal(preset.brightness * multiplier)}:saturation=${decimal(1 + (preset.saturation * multiplier))}:gamma=${decimal(1 + (preset.gamma * multiplier))}`;
}

function overlayBlurFilter(blur) {
  if (!blur || blur <= 0) return '';
  // The user-facing 0..1 amount maps openly to a bounded box-blur radius.
  // The chosen value is stored in the recipe as edits.overlay.blur.
  const radius = Math.max(1, Math.round(blur * 24));
  return `,boxblur=luma_radius=${radius}:luma_power=1:chroma_radius=${radius}:chroma_power=1`;
}

function qualityCrf(quality) {
  if (quality === 'low') return '24';
  if (quality === 'medium') return '20';
  if (quality === 'high') return '18';
  return '20';
}

/**
 * Turn a validated recipe into an argv array for child_process.execFile().
 * This function never invokes a shell.  It always removes container metadata
 * before writing only explicitly resolved title/comment fields.
 */
export function buildFfmpegArgs(recipe, { outputPath, overwrite = false } = {}) {
  const normalizedRecipe = assertRecipeMatchesIdentity(recipe);
  const normalizedOutputPath = normalizedPath(outputPath, 'outputPath', { extensions: new Set(['.mp4']) });
  if (normalizedOutputPath === normalizedRecipe.source.filePath) {
    throw recipeError('outputPath must differ from source.filePath.');
  }
  if (typeof overwrite !== 'boolean') throw recipeError('overwrite must be a boolean.');

  const { source, edits } = normalizedRecipe;
  const args = ['-hide_banner', '-nostdin', overwrite ? '-y' : '-n', '-i', source.filePath];
  let nextInput = 1;
  let overlayInput = null;
  let musicInput = null;
  if (edits.overlay) {
    overlayInput = nextInput;
    nextInput += 1;
    args.push('-i', edits.overlay.filePath);
  }
  if (edits.audio.mode === 'mix') {
    musicInput = nextInput;
    nextInput += 1;
    args.push('-stream_loop', '-1', '-i', edits.audio.musicPath);
  }

  const filters = [];
  let nextVideoLabel = 0;
  let videoLabel = '[0:v]';
  const addVideoFilter = filter => {
    const outputLabel = `[v${nextVideoLabel}]`;
    nextVideoLabel += 1;
    filters.push(`${videoLabel}${filter}${outputLabel}`);
    videoLabel = outputLabel;
  };
  if (edits.pace !== 1) addVideoFilter(`setpts=PTS/${decimal(edits.pace)}`);
  if (edits.crop) addVideoFilter(cropFilter(edits.crop));
  if (edits.scale) addVideoFilter(scaleFilter(edits.scale));
  if (edits.color) addVideoFilter(colorCorrectionFilter(edits.color));
  if (edits.video?.fps) addVideoFilter(`fps=fps=${edits.video.fps}`);
  if (edits.overlay) {
    const overlayLabel = `[overlay${nextVideoLabel}]`;
    const outputLabel = `[v${nextVideoLabel}]`;
    nextVideoLabel += 1;
    filters.push(`[${overlayInput}:v]scale=${edits.overlay.width}:-1,format=rgba,colorchannelmixer=aa=${decimal(edits.overlay.opacity)}${overlayBlurFilter(edits.overlay.blur)}${overlayLabel}`);
    filters.push(`${videoLabel}${overlayLabel}overlay=${overlayCoordinates(edits.overlay.position, edits.overlay.margin)}:format=auto${outputLabel}`);
    videoLabel = outputLabel;
  }
  if (edits.text) addVideoFilter(drawtextFilter(edits.text));

  let audioMap = null;
  if (edits.audio.mode !== 'mute') {
    const needsAudioFilter = source.hasAudio === true && (edits.pace !== 1 || edits.audio.mode === 'gain' || edits.audio.mode === 'mix');
    let audioLabel = '[0:a]';
    if (needsAudioFilter) {
      const audioParts = [];
      if (edits.pace !== 1) audioParts.push(`atempo=${decimal(edits.pace)}`);
      if (edits.audio.mode === 'gain') audioParts.push(`volume=${decimal(edits.audio.gainDb)}dB`);
      if (edits.audio.mode === 'mix') audioParts.push(`volume=${decimal(edits.audio.sourceGainDb)}dB`);
      audioLabel = '[sourceAudio]';
      filters.push(`[0:a]${audioParts.join(',')}${audioLabel}`);
    }
    if (edits.audio.mode === 'mix') {
      filters.push(`[${musicInput}:a]volume=${decimal(edits.audio.musicGainDb)}dB[musicAudio]`);
      filters.push(`${audioLabel}[musicAudio]amix=inputs=2:duration=first:dropout_transition=0[audioOut]`);
      audioMap = '[audioOut]';
    } else if (needsAudioFilter) {
      audioMap = audioLabel;
    } else {
      audioMap = '0:a?';
    }
  }

  if (filters.length) args.push('-filter_complex', filters.join(';'));
  args.push('-map', videoLabel === '[0:v]' ? '0:v:0' : videoLabel);
  if (audioMap) args.push('-map', audioMap);
  // Clear inherited container fields first.  The narrowly-whitelisted title
  // and comment below are the only export metadata this module can write.
  args.push('-map_metadata', '-1', '-map_chapters', '-1');
  if (edits.metadata?.title) args.push('-metadata', `title=${edits.metadata.title}`);
  if (edits.metadata?.comment) args.push('-metadata', `comment=${edits.metadata.comment}`);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
  );
  if (edits.video?.bitrateKbps) {
    const bitrate = `${edits.video.bitrateKbps}k`;
    args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', `${edits.video.bitrateKbps * 2}k`);
  } else {
    args.push('-crf', qualityCrf(edits.video?.quality));
  }
  args.push('-pix_fmt', 'yuv420p');
  if (edits.audio.mode === 'mute') {
    args.push('-an');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-movflags', '+faststart', normalizedOutputPath);
  return args;
}

/**
 * Validate a persisted recipe before a worker uses it.  This is intentionally
 * exported so a backend can reject edited/stale recipe objects at execution.
 */
export function validateEditorialRecipe(recipe) {
  return assertRecipeMatchesIdentity(recipe);
}
