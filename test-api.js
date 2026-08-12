import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
process.env.PORT = '0';
process.env.CREATOR_FLOW_BACKGROUND = '0';
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flow-test-'));
process.env.CREATOR_FLOW_STATE_PATH = path.join(testStateDir, 'state.json');
const productionStatePath = path.join(process.cwd(), '.creator-flow-state.json');
const productionHashBefore = fs.existsSync(productionStatePath)
  ? crypto.createHash('sha256').update(fs.readFileSync(productionStatePath)).digest('hex')
  : null;
const inputPath = path.join(process.cwd(), '.test-input.mp4');
const outputPath = path.join(process.cwd(), '.test-output.mp4');
const { server } = await import('./server.js');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(typeof health.configured, 'boolean');
  assert.equal(typeof health.remoteApi, 'boolean');
  const configuredWorkers = await (await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxConcurrentTasks: 10 }) })).json();
  assert.equal(configuredWorkers.settings.maxConcurrentTasks, 10);
  assert.equal(configuredWorkers.worker.limit, 10);
  const profiles = await (await fetch(`${base}/api/profiles`)).json();
  assert.ok(profiles.data || profiles.error);
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(Array.isArray(tasks.tasks));
  const proxies = await (await fetch(`${base}/api/proxies`)).json();
  assert.ok(Array.isArray(proxies.proxies));
  const importResult = await (await fetch(`${base}/api/proxies/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'http', text: '# test\n127.0.0.1:8080\ninvalid' }) })).json();
  assert.equal(importResult.imported, 1);
  const createdVideo = await (await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Smoke test', videoPath: 'C:/test.mp4', profileId: 'test-profile', views: 301, origin: 'smoke-test' }) })).json();
  assert.equal(createdVideo.status, 'published');
  const stats = await (await fetch(`${base}/api/videos/stats`)).json();
  assert.ok(stats.count >= 1 && stats.over300 >= 1);
  const studioVideos = await (await fetch(`${base}/api/studio-videos?profileId=test-profile`)).json();
  assert.equal(studioVideos.total, 0);
  const createdBatchResponse = await fetch(`${base}/api/studio/sync-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: ['test-profile', 'test-profile'] }),
  });
  assert.equal(createdBatchResponse.status, 202);
  const createdBatch = await createdBatchResponse.json();
  assert.equal(createdBatch.batch.total, 1);
  const batches = await (await fetch(`${base}/api/studio/sync-batches`)).json();
  assert.equal(batches.batches.length, 1);
  assert.equal(batches.batches[0].queued, 1);
  const channelTask = await (await fetch(`${base}/api/channels/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'test-profile', name: 'Test channel', description: 'Test description', links: [{ title: 'Site', url: 'https://example.com' }] }) })).json();
  assert.equal(channelTask.status, 'queued');
  const channelTasks = await (await fetch(`${base}/api/channels/tasks`)).json();
  assert.equal(channelTasks.tasks.length, 1);
  const uniqueizer = await (await fetch(`${base}/api/uniqueizer/health`)).json();
  assert.equal(typeof uniqueizer.available, 'boolean');
  if (uniqueizer.available) {
    const execFileAsync = promisify(execFile);
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.2', '-c:v', 'libx264', inputPath]);
    const render = await (await fetch(`${base}/api/uniqueizer/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputPath, outputPath }) })).json();
    assert.equal(render.status, 'completed'); assert.ok(fs.existsSync(outputPath));
    const imported = await (await fetch(`${base}/api/library/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: outputPath }) })).json();
    assert.equal(imported.item.hasVideo, true);
    const library = await (await fetch(`${base}/api/library`)).json();
    assert.equal(library.library.length, 1);
  }
  console.log('API smoke test passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(inputPath, { force: true });
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(testStateDir, { recursive: true, force: true });
  if (productionHashBefore !== null) {
    const productionHashAfter = crypto.createHash('sha256').update(fs.readFileSync(productionStatePath)).digest('hex');
    assert.equal(productionHashAfter, productionHashBefore, 'Тест не должен менять пользовательский файл состояния.');
  }
}
