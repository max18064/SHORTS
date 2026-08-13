import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildFfmpegArgs,
  createEditorialCampaignPlan,
  createEditorialRecipe,
  EDITORIAL_METADATA_PRESETS,
  EDITORIAL_PRESETS,
  listEditorialMetadataPresets,
  listEditorialPresets,
  normalizeEditorialEdits,
  resolveEditorialMetadataPreset,
  resolveEditorialPreset,
  validateEditorialRecipe,
} from './variant-recipes.js';

const fixtures = path.resolve('fixtures');
const source = {
  id: 'source-a',
  filePath: path.join(fixtures, 'source-a.mp4'),
  hasAudio: true,
};
const editorialEdits = {
  crop: { aspect: '9:16', position: 'center' },
  scale: { width: 1080, height: 1920, fit: 'cover' },
  overlay: {
    filePath: path.join(fixtures, 'title.png'),
    position: 'bottom-right',
    opacity: 0.6,
    width: 240,
    margin: 32,
  },
  pace: 1.03,
  audio: {
    mode: 'mix',
    musicPath: path.join(fixtures, 'bed.mp3'),
    sourceGainDb: -2,
    musicGainDb: -18,
  },
};

const first = createEditorialRecipe({
  source,
  campaignId: 'august-editorial',
  variantIndex: 1,
  profileId: 'vertical-with-title',
  edits: editorialEdits,
});
const second = createEditorialRecipe({
  source,
  campaignId: 'august-editorial',
  variantIndex: 1,
  profileId: 'vertical-with-title',
  edits: editorialEdits,
});
assert.equal(first.recipeId, second.recipeId, 'same recipe input must stay deterministic');
assert.equal(first.renderSignature, second.renderSignature, 'same render must retain its transparent signature');
assert.deepEqual(validateEditorialRecipe(first), first, 'validated recipe must normalize to the original recipe');

const args = buildFfmpegArgs(first, { outputPath: path.join(fixtures, 'output-a.mp4') });
assert.ok(args.includes('-filter_complex'));
assert.ok(args.includes('-map_metadata'));
assert.ok(args.includes('-map_chapters'));
assert.ok(args.includes('-stream_loop'));
assert.ok(args.includes(source.filePath));
assert.ok(args.includes(path.join(fixtures, 'title.png')));
assert.ok(args.includes(path.join(fixtures, 'bed.mp3')));
assert.equal(args.includes('-metadata'), false, 'recipe must not invent container metadata');
assert.equal(args.at(-1), path.join(fixtures, 'output-a.mp4'));

const explicitVisualEdits = {
  ...editorialEdits,
  overlay: {
    ...editorialEdits.overlay,
    blur: { min: 0.2, max: 0.65 },
  },
  text: {
    value: "We're: ready, [cut]; \\again",
    fontFile: path.join(fixtures, 'headline.ttf'),
    size: 72,
    position: 'top-center',
    color: '#F5A623',
    outline: { color: '#112233', width: 4 },
    margin: 40,
    yPercent: 37.5,
  },
  color: { level: 'medium', amount: 65 },
  video: { fps: 30, quality: 'high' },
};
const visualRecipe = createEditorialRecipe({
  source,
  campaignId: 'visible-editorial-edits',
  variantIndex: 3,
  profileId: 'captioned',
  edits: explicitVisualEdits,
});
assert.ok(visualRecipe.edits.overlay.blur >= 0.2 && visualRecipe.edits.overlay.blur <= 0.65);
assert.deepEqual(visualRecipe.edits.overlay.blurBounds, { min: 0.2, max: 0.65 });
assert.deepEqual(visualRecipe.edits.text.outline, { color: '#112233', width: 4 });
assert.equal(visualRecipe.edits.text.yPercent, 37.5);
assert.deepEqual(visualRecipe.edits.color, { level: 'medium', amount: 65 });
assert.deepEqual(visualRecipe.edits.video, { fps: 30, quality: 'high' });
assert.ok(visualRecipe.materialChanges.includes('color-medium-65pct'));
assert.ok(visualRecipe.materialChanges.includes('fps-30'));
assert.ok(visualRecipe.materialChanges.includes('quality-high'));
assert.ok(visualRecipe.materialChanges.some(change => change.startsWith('overlay-blur-')));
assert.ok(visualRecipe.materialChanges.includes('text-top-center-72px'));

const visualArgs = buildFfmpegArgs(visualRecipe, { outputPath: path.join(fixtures, 'output-visual.mp4') });
const visualFilters = visualArgs[visualArgs.indexOf('-filter_complex') + 1];
assert.ok(visualFilters.includes('boxblur=luma_radius='), 'the resolved overlay blur must be rendered visibly');
assert.ok(visualFilters.includes('eq=contrast=1.0455:brightness=0.0065:saturation=1.0585:gamma=1.0195'));
assert.ok(visualFilters.includes('fps=fps=30'));
assert.ok(visualFilters.includes("text='We\\'re\\: ready\\, \\[cut\\]\\; \\\\again'"), 'drawtext content must be escaped for FFmpeg without a shell');
assert.ok(visualFilters.includes("fontfile='"), 'drawtext must receive the required font file');
assert.ok(visualFilters.includes(':expansion=none:'), 'drawtext text must stay literal and reproducible');
assert.ok(visualFilters.includes(':x=(w-text_w)/2:y='), 'text X coordinate must be emitted as a complete expression');
assert.ok(visualFilters.includes(':y=h*0.375-text_h/2'), 'text Y percent must map to the visible exact vertical position');
assert.ok(visualFilters.includes('borderw=4:bordercolor=0x112233'));
assert.equal(visualArgs.includes('-r'), false, 'target FPS stays in the explicit filter graph');
assert.equal(visualArgs.includes('-b:v'), false, 'quality mode must use CRF rather than a conflicting bitrate');
assert.equal(visualArgs[visualArgs.indexOf('-crf') + 1], '18');

const bitrateRecipe = createEditorialRecipe({
  source,
  campaignId: 'bitrate-editorial',
  edits: { video: { bitrateKbps: 4_500 } },
});
const bitrateArgs = buildFfmpegArgs(bitrateRecipe, { outputPath: path.join(fixtures, 'output-bitrate.mp4') });
assert.equal(bitrateArgs[bitrateArgs.indexOf('-b:v') + 1], '4500k');
assert.equal(bitrateArgs[bitrateArgs.indexOf('-maxrate') + 1], '4500k');
assert.equal(bitrateArgs.includes('-crf'), false, 'bitrate mode must not add a competing CRF target');

assert.throws(
  () => createEditorialRecipe({ source, edits: { text: { value: 'Caption', size: 52 } } }),
  /fontFile/,
  'visible text must require a real font file path',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { color: 'vivid' } }),
  /edits\.color/,
  'color correction must remain within its declared levels',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { video: { bitrateKbps: 4_500, quality: 'high' } } }),
  /bitrateKbps or edits\.video\.quality/,
  'bitrate and CRF quality targets must not conflict',
);

const blurredPlan = createEditorialCampaignPlan({
  sources: [source],
  outputCount: 5,
  campaignId: 'bounded-blur-spread',
  profiles: [{
    id: 'visible-overlay',
    edits: { overlay: { filePath: path.join(fixtures, 'title.png'), width: 240, blur: { min: 0.1, max: 0.9 } } },
  }],
});
const plannedBlurValues = blurredPlan.recipes.map(recipe => recipe.edits.overlay.blur);
assert.ok(plannedBlurValues.every(value => value >= 0.1 && value <= 0.9));
assert.ok(new Set(plannedBlurValues).size > 1, 'output-index seeds should resolve a declared blur range into visible, bounded variation');
assert.deepEqual(
  createEditorialCampaignPlan({
    sources: [source],
    outputCount: 5,
    campaignId: 'bounded-blur-spread',
    profiles: [{
      id: 'visible-overlay',
      edits: { overlay: { filePath: path.join(fixtures, 'title.png'), width: 240, blur: { min: 0.1, max: 0.9 } } },
    }],
  }).recipes.map(recipe => recipe.edits.overlay.blur),
  plannedBlurValues,
  'the resolved value is reproducible for the same campaign identity',
);

assert.throws(
  () => createEditorialRecipe({ source, edits: { pace: 1.2 } }),
  /edits\.pace/,
  'pacing must remain a modest, explicit editorial setting',
);
assert.throws(
  () => createEditorialRecipe({ source: { ...source, hasAudio: false }, edits: { audio: { mode: 'mix', musicPath: 'bed.mp3' } } }),
  /requires source\.hasAudio=true/,
  'mixing must not silently assume a source audio stream',
);
assert.throws(
  () => validateEditorialRecipe({ ...first, recipeId: 'edr-tampered' }),
  /recipeId does not match/,
  'worker-side validation must reject changed recipe content',
);

assert.deepEqual(
  listEditorialMetadataPresets().map(preset => preset.id),
  ['clean', 'source-title', 'project-export'],
  'the public metadata selector must expose only its three deterministic presets',
);
assert.equal(EDITORIAL_METADATA_PRESETS.length, 3, 'metadata preset definitions stay available to callers');
const cleanMetadata = resolveEditorialMetadataPreset({
  presetId: 'clean', source, campaignId: 'metadata-test', variantIndex: 7,
});
assert.deepEqual(cleanMetadata, { presetId: 'clean' }, 'clean must not generate fields after stripping');
const sourceTitleMetadata = resolveEditorialMetadataPreset({
  presetId: 'source-title', source, campaignId: 'metadata-test', variantIndex: 7,
});
assert.deepEqual(sourceTitleMetadata, {
  presetId: 'source-title',
  title: 'source-a',
  comment: 'Local Creator Flow export',
}, 'source-title must be derived from the source basename, not a random value');
const projectMetadata = resolveEditorialMetadataPreset({
  presetId: 'project-export', source, campaignId: 'metadata-test', variantIndex: 7,
});
assert.deepEqual(projectMetadata, {
  presetId: 'project-export',
  title: 'Creator Flow export 7',
  comment: 'Local project export',
}, 'project-export values must be deterministic and free from device/date fields');
assert.deepEqual(
  resolveEditorialMetadataPreset({
    presetId: 'user-list', source, campaignId: 'metadata-test', variantIndex: 7,
    title: 'Mapped title', comment: 'Mapped comment',
  }),
  { presetId: 'user-list', title: 'Mapped title', comment: 'Mapped comment' },
  'user-list must preserve only explicit per-output title/comment values',
);
assert.throws(
  () => resolveEditorialMetadataPreset({ presetId: 'user-list', source }),
  /requires an explicit title/,
  'user-list cannot create a title on its own',
);
assert.throws(
  () => resolveEditorialMetadataPreset({ presetId: 'creation_time', source }),
  /presetId is not supported/,
  'platform-facing metadata preset IDs must be rejected',
);

const metadataRecipe = createEditorialRecipe({
  source,
  campaignId: 'metadata-test',
  variantIndex: 7,
  profileId: 'metadata-profile',
  edits: { metadata: projectMetadata },
});
assert.deepEqual(metadataRecipe.edits.metadata, projectMetadata);
assert.ok(metadataRecipe.materialChanges.includes('metadata-project-export'));
assert.notEqual(
  metadataRecipe.renderSignature,
  createEditorialRecipe({
    source, campaignId: 'metadata-test', variantIndex: 7, profileId: 'metadata-profile', edits: { metadata: cleanMetadata },
  }).renderSignature,
  'explicit metadata choices must be part of a transparent render signature',
);
const metadataArgs = buildFfmpegArgs(metadataRecipe, { outputPath: path.join(fixtures, 'output-metadata.mp4') });
const metadataMapIndex = metadataArgs.indexOf('-map_metadata');
const titleMetadataIndex = metadataArgs.indexOf('-metadata');
assert.ok(metadataMapIndex >= 0 && metadataArgs[metadataMapIndex + 1] === '-1', 'metadata must be stripped before an explicit write');
assert.ok(titleMetadataIndex > metadataMapIndex, 'explicit metadata must be written only after stripping');
assert.deepEqual(metadataArgs.slice(titleMetadataIndex, titleMetadataIndex + 4), [
  '-metadata', 'title=Creator Flow export 7', '-metadata', 'comment=Local project export',
]);
assert.equal(metadataArgs.some(value => /creation_time|encoder|device|uuid|identifier/i.test(value)), false,
  'the export argv must not contain date, device, encoder, or identifier fields');
const cleanMetadataArgs = buildFfmpegArgs(createEditorialRecipe({
  source, campaignId: 'metadata-test', variantIndex: 8, profileId: 'metadata-profile', edits: { metadata: cleanMetadata },
}), { outputPath: path.join(fixtures, 'output-clean-metadata.mp4') });
assert.equal(cleanMetadataArgs.includes('-metadata'), false, 'clean exports must not write title/comment fields');
assert.throws(
  () => createEditorialRecipe({ source, edits: { metadata: { presetId: 'clean', title: 'Not allowed' } } }),
  /must not contain title or comment/,
  'clean metadata accepts no fields after stripping',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { metadata: { presetId: 'user-list', title: 'Allowed', device: 'not allowed' } } }),
  /not allowed/,
  'metadata schema must reject every field outside presetId/title/comment',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { metadata: { presetId: 'user-list', comment: 'No title' } } }),
  /requires an explicit title/,
  'user-list must receive an explicit title for the individual output',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { metadata: { presetId: 'project-export', title: 'Only title' } } }),
  /requires an explicit comment/,
  'named metadata presets must include their explicit comment',
);
assert.throws(
  () => createEditorialRecipe({ source, edits: { metadata: { presetId: 'user-list', title: 'x'.repeat(201) } } }),
  /edits\.metadata\.title is too long/,
  'metadata titles must have a strict bounded length',
);
assert.throws(
  () => createEditorialRecipe({
    source,
    edits: { metadata: { presetId: 'user-list', title: 'Valid title', comment: 'x'.repeat(501) } },
  }),
  /edits\.metadata\.comment is too long/,
  'metadata comments must have a strict bounded length',
);

assert.deepEqual(
  listEditorialPresets().map(preset => preset.id),
  ['manual', 'shorts-balanced', 'soft-editorial', 'square-stories'],
  'the public preset catalogue must expose the supported stable IDs',
);
assert.equal(EDITORIAL_PRESETS.length, 4, 'the frozen preset definitions remain available to callers');
const manualPresetEdits = resolveEditorialPreset({
  baseEdits: { pace: 1, audio: { mode: 'keep' } },
  source,
  campaignId: 'preset-test',
  variantIndex: 1,
  profileId: 'local',
});
assert.deepEqual(
  manualPresetEdits,
  normalizeEditorialEdits({ pace: 1, audio: { mode: 'keep' } }, { source }),
  'manual preset must not add changes',
);

const presetVariants = Array.from({ length: 10 }, (_, index) => resolveEditorialPreset({
  presetId: 'shorts-balanced',
  baseEdits: {
    overlay: { filePath: path.join(fixtures, 'title.png'), width: 240 },
    audio: { mode: 'keep' },
  },
  source,
  campaignId: 'preset-test',
  variantIndex: index + 1,
  profileId: 'local',
}));
const presetRecipes = presetVariants.map((edits, index) => createEditorialRecipe({
  source,
  campaignId: 'preset-test',
  variantIndex: index + 1,
  profileId: 'local',
  edits,
}));
assert.ok(presetVariants.every(edits => edits.overlay?.filePath === path.join(fixtures, 'title.png')),
  'a preset must preserve an explicitly supplied overlay rather than inventing one');
assert.equal(presetVariants.some(edits => edits.text), false, 'a preset must not add text without caller input');
assert.equal(new Set(presetVariants.map(edits => edits.pace)).size, 10,
  'ten preset outputs must use ten explicit pace values rather than duplicate parameters');
assert.equal(new Set(presetRecipes.map(recipe => recipe.renderSignature)).size, 10,
  'ten preset outputs must produce distinct transparent render signatures');
assert.deepEqual(
  resolveEditorialPreset({
    presetId: 'soft-editorial', baseEdits: {}, source, campaignId: 'preset-test', variantIndex: 4, profileId: 'local',
  }),
  resolveEditorialPreset({
    presetId: 'soft-editorial', baseEdits: {}, source, campaignId: 'preset-test', variantIndex: 4, profileId: 'local',
  }),
  'a preset must resolve deterministically for the same output identity',
);
assert.throws(
  () => resolveEditorialPreset({ presetId: 'unknown', baseEdits: {}, source }),
  /presetId is not supported/,
  'unknown preset IDs must be rejected',
);

const sources = Array.from({ length: 5 }, (_, index) => ({
  id: `source-${index + 1}`,
  filePath: path.join(fixtures, `source-${index + 1}.mp4`),
  hasAudio: true,
}));
const plan = createEditorialCampaignPlan({
  sources,
  outputCount: 50,
  campaignId: 'five-to-fifty-editorial',
  profiles: [
    { id: 'normalized', edits: {} },
    { id: 'vertical', edits: { crop: { aspect: '9:16', position: 'center' }, scale: { width: 1080, height: 1920, fit: 'cover' } } },
  ],
});
assert.equal(plan.recipes.length, 50);
assert.deepEqual(
  sources.map(item => plan.recipes.filter(recipe => recipe.source.id === item.id).length),
  [10, 10, 10, 10, 10],
  'round-robin planning must distribute 50 outputs evenly across five sources',
);
assert.ok(plan.duplicateRenderGroups.length > 0, 'repeated transparent render settings must be reported');
assert.deepEqual(
  createEditorialCampaignPlan({
    sources,
    outputCount: 50,
    campaignId: 'five-to-fifty-editorial',
    profiles: [
      { id: 'normalized', edits: {} },
      { id: 'vertical', edits: { crop: { aspect: '9:16', position: 'center' }, scale: { width: 1080, height: 1920, fit: 'cover' } } },
    ],
  }),
  plan,
  'campaign plans must be deterministic too',
);

console.log('variant recipe tests passed');
