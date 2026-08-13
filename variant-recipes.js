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
const MIN_PACE = 0.95;
const MAX_PACE = 1.05;
const AUDIO_MODES = new Set(['keep', 'mute', 'gain', 'mix']);
const OVERLAY_POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
const CROP_ASPECTS = Object.freeze({
  '1:1': { numerator: 1, denominator: 1 },
  '4:5': { numerator: 4, denominator: 5 },
  '9:16': { numerator: 9, denominator: 16 },
  '16:9': { numerator: 16, denominator: 9 },
});
const CROP_POSITIONS = new Set(['center', 'top', 'bottom', 'left', 'right']);
const SCALE_FITS = new Set(['contain', 'cover', 'stretch']);
const MUSIC_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);

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

function normalizeOverlay(rawOverlay) {
  if (rawOverlay === undefined || rawOverlay === null || rawOverlay === false) return null;
  const overlay = asPlainObject(rawOverlay, 'edits.overlay');
  const position = normalizedText(overlay.position ?? 'bottom-right', 'edits.overlay.position', { required: true, maxLength: 24 });
  if (!OVERLAY_POSITIONS.has(position)) throw recipeError('edits.overlay.position is not supported.');
  return {
    filePath: normalizedPath(overlay.filePath, 'edits.overlay.filePath', { extensions: new Set(['.png']) }),
    position,
    opacity: normalizedNumber(overlay.opacity ?? 1, 'edits.overlay.opacity', { min: 0.05, max: 1 }),
    width: normalizedEvenDimension(overlay.width, 'edits.overlay.width'),
    margin: normalizedInteger(overlay.margin ?? 24, 'edits.overlay.margin', { min: 0, max: MAX_OVERLAY_MARGIN }),
  };
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
export function normalizeEditorialEdits(rawEdits = {}, { source } = {}) {
  const edits = asPlainObject(rawEdits, 'edits');
  const normalizedSource = source ? normalizeSource(source) : null;
  const pace = normalizedNumber(edits.pace ?? 1, 'edits.pace', { min: MIN_PACE, max: MAX_PACE });
  if (!normalizedSource && (edits.audio?.mode === 'gain' || edits.audio?.mode === 'mix' || pace !== 1)) {
    throw recipeError('A source with hasAudio is required to validate these audio edits.');
  }

  return {
    crop: normalizeCrop(edits.crop),
    scale: normalizeScale(edits.scale),
    overlay: normalizeOverlay(edits.overlay),
    pace,
    audio: normalizeAudio(edits.audio, normalizedSource || { hasAudio: null }, pace),
  };
}

function materialChanges(edits) {
  const changes = ['re-encode-h264-aac', 'strip-container-metadata'];
  if (edits.crop) changes.push(`crop-${edits.crop.aspect}-${edits.crop.position}`);
  if (edits.scale) changes.push(`scale-${edits.scale.width}x${edits.scale.height}-${edits.scale.fit}`);
  if (edits.overlay) changes.push(`overlay-${edits.overlay.position}-${Math.round(edits.overlay.opacity * 100)}pct`);
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
  const normalizedEdits = normalizeEditorialEdits(edits, { source: normalizedSource });
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

/**
 * Turn a validated recipe into an argv array for child_process.execFile().
 * This function never invokes a shell.  It always removes container metadata
 * and never writes invented metadata fields.
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
  if (edits.overlay) {
    const overlayLabel = `[overlay${nextVideoLabel}]`;
    const outputLabel = `[v${nextVideoLabel}]`;
    nextVideoLabel += 1;
    filters.push(`[${overlayInput}:v]scale=${edits.overlay.width}:-1,format=rgba,colorchannelmixer=aa=${decimal(edits.overlay.opacity)}${overlayLabel}`);
    filters.push(`${videoLabel}${overlayLabel}overlay=${overlayCoordinates(edits.overlay.position, edits.overlay.margin)}:format=auto${outputLabel}`);
    videoLabel = outputLabel;
  }

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
  args.push(
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
  );
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
