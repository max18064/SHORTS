import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
process.env.PORT = '0';
process.env.CREATOR_FLOW_BACKGROUND = '0';
process.env.DOLPHIN_API_TOKEN = 'isolated-test-token';
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flow-test-'));
process.env.CREATOR_FLOW_STATE_PATH = path.join(testStateDir, 'state.json');
const productionStatePath = path.join(process.cwd(), '.creator-flow-state.json');
const productionHashBefore = fs.existsSync(productionStatePath)
  ? crypto.createHash('sha256').update(fs.readFileSync(productionStatePath)).digest('hex')
  : null;
const inputPath = path.join(process.cwd(), '.test-input.mp4');
const outputPath = path.join(process.cwd(), '.test-output.mp4');
const bulkVideoPath = path.join(testStateDir, 'bulk-source.mp4');
fs.writeFileSync(bulkVideoPath, 'bulk queue test source');
const dolphinCalls = [];
const officialFingerprint = {
  platformName: 'Win32',
  useragent: { mode: 'manual', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  webgl: { mode: 'real' },
};
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
const dolphinMock = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/browser_profiles') {
    return sendJson(response, 200, { data: [{ id: 1, name: 'Test Dolphin profile', platform: 'windows', browserType: 'anty', tags: ['test'] }], total: 1 });
  }
  if (request.method === 'GET' && url.pathname === '/folders') {
    return sendJson(response, 200, { data: [{ id: 42, name: 'Existing folder', emoji: '📁', isPinned: true, browserProfilesData: [{ id: 1 }] }], total: 1 });
  }
  if (request.method === 'POST' && url.pathname === '/folders') {
    const body = await readJson(request);
    dolphinCalls.push({ method: request.method, pathname: url.pathname, body });
    return sendJson(response, 200, { data: { id: 77, ...body, browserProfilesData: [] } });
  }
  if (request.method === 'GET' && url.pathname === '/fingerprints/fingerprint') {
    dolphinCalls.push({ method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()) });
    return sendJson(response, 200, officialFingerprint);
  }
  if (request.method === 'POST' && url.pathname === '/browser_profiles') {
    const body = await readJson(request);
    dolphinCalls.push({ method: request.method, pathname: url.pathname, body });
    return sendJson(response, 200, { success: true, browserProfileId: 555, data: { id: 555 } });
  }
  return sendJson(response, 404, { message: `Unhandled Dolphin mock route: ${request.method} ${url.pathname}` });
});
await new Promise(resolve => dolphinMock.listen(0, '127.0.0.1', resolve));
process.env.DOLPHIN_API_BASE = `http://127.0.0.1:${dolphinMock.address().port}`;
const localDolphinMock = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  // The account-check smoke path intentionally returns no CDP endpoint. This
  // exercises the read-only `automation-unavailable` cache path without
  // opening a browser or relying on a real Dolphin installation.
  if (request.method === 'GET' && /\/v1\.0\/browser_profiles\/1\/start$/.test(url.pathname)) {
    return sendJson(response, 200, { success: true });
  }
  return sendJson(response, 200, { success: true });
});
await new Promise(resolve => localDolphinMock.listen(0, '127.0.0.1', resolve));
process.env.DOLPHIN_LOCAL_API = `http://127.0.0.1:${localDolphinMock.address().port}`;
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
  const folders = await (await fetch(`${base}/api/folders`)).json();
  assert.equal(folders.total, 1);
  assert.deepEqual(folders.data[0], { id: 42, name: 'Existing folder', emoji: '📁', isPinned: true, profileCount: 1 });
  const invalidFolder = await fetch(`${base}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(invalidFolder.status, 400);
  const createdFolder = await (await fetch(`${base}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Batch', emoji: '📦', isPinned: true }),
  })).json();
  assert.deepEqual(createdFolder.folder, { id: 77, name: 'Batch', emoji: '📦', isPinned: true, profileCount: 0 });
  const invalidProfileCreate = await fetch(`${base}/api/profiles/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bad', platform: 'windows', platformVersion: '10.0.0', browserVersion: 138, folderId: 'wrong' }),
  });
  assert.equal(invalidProfileCreate.status, 400);
  const createProfileResponse = await fetch(`${base}/api/profiles/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Creator profile', platform: 'windows', platformVersion: '10.0.0', browserVersion: 138, folderId: 42, tags: ['Work', ' work ', 'Test'] }),
  });
  assert.equal(createProfileResponse.status, 201);
  const createdProfile = await createProfileResponse.json();
  assert.deepEqual(createdProfile.profile, { id: 555, name: 'Creator profile', platform: 'windows', browserType: 'anty', folder: '', folderId: 42, tags: ['Work', 'Test'], lastStartTime: null });
  assert.equal(createdProfile.browserVersion, 138);
  const fingerprintCall = dolphinCalls.find(call => call.pathname === '/fingerprints/fingerprint');
  assert.deepEqual(fingerprintCall.query, { platform: 'windows', browser_type: 'anty', browser_version: '138' });
  const profileCreateCall = dolphinCalls.find(call => call.pathname === '/browser_profiles');
  assert.equal(profileCreateCall.body.proxy, undefined);
  assert.deepEqual(profileCreateCall.body.fingerprint, officialFingerprint);
  assert.deepEqual(profileCreateCall.body.tags, ['Work', 'Test']);
  assert.equal(profileCreateCall.body.folderId, 42);
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(Array.isArray(tasks.tasks));
  const bulkQueueResponse = await fetch(`${base}/api/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileIds: ['test-profile-a', ' test-profile-b ', 'test-profile-a'],
      videoPath: bulkVideoPath,
      titleTemplate: 'Queue {index} for {profileId}',
      description: 'Prepared in an isolated smoke test.',
      tags: ['test', 'bulk'],
    }),
  });
  assert.equal(bulkQueueResponse.status, 201);
  const bulkQueue = await bulkQueueResponse.json();
  assert.equal(bulkQueue.created, 2);
  assert.deepEqual(bulkQueue.profileIds, ['test-profile-a', 'test-profile-b']);
  assert.equal(bulkQueue.autoUpload, false);
  assert.equal(bulkQueue.manualStartRequired, true);
  assert.deepEqual(bulkQueue.tasks.map(task => task.title), ['Queue 1 for test-profile-a', 'Queue 2 for test-profile-b']);
  assert.ok(bulkQueue.tasks.every(task => task.status === 'queued' && task.autoUpload === false && task.videoPath === bulkVideoPath));
  const autoBulkQueueResponse = await fetch(`${base}/api/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileIds: ['test-profile-auto'],
      videoPath: bulkVideoPath,
      titleTemplate: 'Automatic {index}',
      autoUpload: true,
    }),
  });
  assert.equal(autoBulkQueueResponse.status, 201);
  const autoBulkQueue = await autoBulkQueueResponse.json();
  assert.equal(autoBulkQueue.autoUpload, true);
  assert.equal(autoBulkQueue.manualStartRequired, false);
  assert.equal(autoBulkQueue.tasks[0].autoUpload, true);
  const queuedTasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.equal(queuedTasks.tasks.length, 3);
  const overLimitResponse = await fetch(`${base}/api/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileIds: Array.from({ length: 101 }, (_, index) => `test-profile-${index}`),
      videoPath: bulkVideoPath,
      titleTemplate: 'Over limit {index}',
    }),
  });
  assert.equal(overLimitResponse.status, 400);
  const invalidIdsResponse = await fetch(`${base}/api/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: ['test-profile-c', '   '], videoPath: bulkVideoPath, titleTemplate: 'Invalid {index}' }),
  });
  assert.equal(invalidIdsResponse.status, 400);
  const tasksAfterRejectedBulk = await (await fetch(`${base}/api/tasks`)).json();
  assert.equal(tasksAfterRejectedBulk.tasks.length, 3);
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
  const emptyAccounts = await (await fetch(`${base}/api/accounts`)).json();
  assert.deepEqual(emptyAccounts, { accounts: [], total: 0 });
  const individualAccountCheckResponse = await fetch(`${base}/api/profiles/1/youtube-status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restart: false }),
  });
  assert.equal(individualAccountCheckResponse.status, 200);
  const individualAccountCheck = await individualAccountCheckResponse.json();
  assert.equal(individualAccountCheck.profileId, '1');
  assert.equal(individualAccountCheck.channel.status, 'automation-unavailable');
  assert.deepEqual(Object.keys(individualAccountCheck.channel).sort(), ['channelName', 'checkedAt', 'status', 'url']);
  const cachedAccounts = await (await fetch(`${base}/api/accounts`)).json();
  assert.equal(cachedAccounts.total, 1);
  assert.equal(cachedAccounts.accounts[0].profileId, '1');
  assert.equal(cachedAccounts.accounts[0].status, 'automation-unavailable');
  const persistedAfterIndividualCheck = JSON.parse(fs.readFileSync(process.env.CREATOR_FLOW_STATE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(persistedAfterIndividualCheck.accountStatusCache['1']).sort(), ['channelName', 'checkedAt', 'status', 'url']);
  const createdAccountBatchResponse = await fetch(`${base}/api/accounts/check-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: ['1', ' 1 '] }),
  });
  assert.equal(createdAccountBatchResponse.status, 202);
  const createdAccountBatch = await createdAccountBatchResponse.json();
  assert.equal(createdAccountBatch.batch.total, 1);
  assert.equal(createdAccountBatch.batch.queued, 1);
  assert.deepEqual(createdAccountBatch.batch.items.map(item => item.profileId), ['1']);
  const accountBatches = await (await fetch(`${base}/api/accounts/check-batches`)).json();
  assert.equal(accountBatches.batches.length, 1);
  const oversizedAccountBatch = await fetch(`${base}/api/accounts/check-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: Array.from({ length: 101 }, (_, index) => `account-${index}`) }),
  });
  assert.equal(oversizedAccountBatch.status, 400);
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
  await new Promise(resolve => dolphinMock.close(resolve));
  await new Promise(resolve => localDolphinMock.close(resolve));
  fs.rmSync(inputPath, { force: true });
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(bulkVideoPath, { force: true });
  fs.rmSync(testStateDir, { recursive: true, force: true });
  if (productionHashBefore !== null) {
    const productionHashAfter = crypto.createHash('sha256').update(fs.readFileSync(productionStatePath)).digest('hex');
    assert.equal(productionHashAfter, productionHashBefore, 'Тест не должен менять пользовательский файл состояния.');
  }
}
