import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRESET_OVERLAY_SPECS, ensurePresetOverlayAssets } from './preset-overlay-assets.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flow-preset-overlays-'));

try {
  const assets = ensurePresetOverlayAssets({ directory: temporaryDirectory });
  assert.equal(PRESET_OVERLAY_SPECS.length, 10, 'ten built-in overlay specifications are expected');
  assert.equal(assets.length, 10, 'one PNG should be produced for every specification');
  assert.equal(new Set(assets).size, 10, 'asset paths must not collide');

  for (const [index, assetPath] of assets.entries()) {
    assert.equal(path.isAbsolute(assetPath), true, 'all returned asset paths must be absolute');
    assert.equal(path.basename(assetPath), `${PRESET_OVERLAY_SPECS[index].id}.png`);
    const content = fs.readFileSync(assetPath);
    assert.equal(content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true, 'asset must begin with a PNG signature');
    assert.equal(content.readUInt32BE(8), 13, 'asset must contain an IHDR chunk');
    assert.equal(content.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(content.readUInt32BE(16), 640);
    assert.equal(content.readUInt32BE(20), 200);
    assert.equal(content[24], 8, 'asset must use 8-bit channels');
    assert.equal(content[25], 6, 'asset must use RGBA PNG color type');
  }

  const firstAsset = assets[0];
  const before = fs.statSync(firstAsset);
  const secondAssets = ensurePresetOverlayAssets({ directory: temporaryDirectory });
  const after = fs.statSync(firstAsset);
  assert.deepEqual(secondAssets, assets, 'repeated calls must resolve the same ordered paths');
  assert.equal(after.mtimeMs, before.mtimeMs, 'valid preset assets must remain untouched on repeated calls');

  fs.writeFileSync(firstAsset, Buffer.from('not-a-png'));
  ensurePresetOverlayAssets({ directory: temporaryDirectory });
  const repaired = fs.readFileSync(firstAsset);
  assert.equal(repaired.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true, 'an invalid asset must be regenerated');
  assert.equal(repaired[25], 6, 'a regenerated asset must preserve RGBA format');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('preset overlay asset tests passed');
