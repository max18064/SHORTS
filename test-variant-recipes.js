import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildFfmpegArgs,
  createEditorialCampaignPlan,
  createEditorialRecipe,
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
