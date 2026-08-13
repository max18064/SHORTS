import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
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
const processingOutputPath = path.join(testStateDir, 'batch-processed.mp4');
const campaignOutputOne = path.join(testStateDir, 'campaign-1.mp4');
const campaignOutputTwo = path.join(testStateDir, 'campaign-2.mp4');
const campaignVisualOutput = path.join(testStateDir, 'campaign-visual-1.mp4');
const campaignPresetRenderOutput = path.join(testStateDir, 'campaign-preset-render-1.mp4');
const campaignOverlayPath = path.join(testStateDir, 'campaign-overlay.png');
const bulkVideoPath = path.join(testStateDir, 'bulk-source.mp4');
const channelAvatarPath = path.join(testStateDir, 'channel-avatar.png');
const channelBannerPath = path.join(testStateDir, 'channel-banner.png');
const channelAssetDirectory = path.join(testStateDir, 'channel-asset-directory');
fs.writeFileSync(bulkVideoPath, 'bulk queue test source');
fs.writeFileSync(channelAvatarPath, 'channel branding test asset');
fs.writeFileSync(channelBannerPath, 'channel branding banner asset');
fs.mkdirSync(channelAssetDirectory);
const dolphinCalls = [];
const localDolphinCalls = [];
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
  const startMatch = request.method === 'GET'
    ? url.pathname.match(/^\/v1\.0\/browser_profiles\/([^/]+)\/start$/)
    : null;
  if (startMatch) {
    localDolphinCalls.push({ profileId: decodeURIComponent(startMatch[1]), automation: url.searchParams.get('automation') });
    if (decodeURIComponent(startMatch[1]) === 'mock-start-failure') {
      return sendJson(response, 503, { error: 'Isolated Dolphin start failure' });
    }
    return sendJson(response, 200, { success: true });
  }
  return sendJson(response, 200, { success: true });
});
await new Promise(resolve => localDolphinMock.listen(0, '127.0.0.1', resolve));
process.env.DOLPHIN_LOCAL_API = `http://127.0.0.1:${localDolphinMock.address().port}`;
const { server } = await import('./server.js');
if (!server.listening) await once(server, 'listening');
const serverAddress = server.address();
assert.ok(serverAddress && typeof serverAddress === 'object');
assert.equal(serverAddress.address, '127.0.0.1');
const port = serverAddress.port;
const base = `http://127.0.0.1:${port}`;
try {
  const panel = await fetch(`${base}/`);
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /Creator Flow/);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/data/library/`)).status, 404);
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
  const lifecycleTaskResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: 'lifecycle-profile',
      videoPath: bulkVideoPath,
      title: 'Lifecycle guard',
      autoUpload: false,
    }),
  });
  assert.equal(lifecycleTaskResponse.status, 201);
  const lifecycleTask = await lifecycleTaskResponse.json();
  const queuedUpload = await fetch(`${base}/api/tasks/${lifecycleTask.id}/upload`, { method: 'POST' });
  assert.equal(queuedUpload.status, 409);
  assert.equal((await queuedUpload.json()).code, 'invalid-task-state');
  const cancelledLifecycleTask = await fetch(`${base}/api/tasks/${lifecycleTask.id}/cancel`, { method: 'POST' });
  assert.equal(cancelledLifecycleTask.status, 200);
  assert.equal((await cancelledLifecycleTask.json()).status, 'cancelled');
  const cancelledRun = await fetch(`${base}/api/tasks/${lifecycleTask.id}/run`, { method: 'POST' });
  assert.equal(cancelledRun.status, 409);
  assert.equal((await cancelledRun.json()).code, 'invalid-task-state');
  const cancelledLogin = await fetch(`${base}/api/tasks/${lifecycleTask.id}/prepare-login`, { method: 'POST' });
  assert.equal(cancelledLogin.status, 409);
  assert.equal((await cancelledLogin.json()).code, 'invalid-task-state');
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
  const channelTaskResponse = await fetch(`${base}/api/channels/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: ' test-profile ',
      name: '  Test channel  ',
      description: '  Test description  ',
      links: [{ title: ' Site ', url: 'https://example.com/channel' }],
      avatarPath: channelAvatarPath,
      bannerPath: channelBannerPath,
    }),
  });
  assert.equal(channelTaskResponse.status, 201);
  const channelTask = await channelTaskResponse.json();
  assert.equal(channelTask.status, 'queued');
  assert.equal(channelTask.source, 'single');
  assert.equal(channelTask.profileId, 'test-profile');
  assert.equal(channelTask.name, 'Test channel');
  assert.equal(channelTask.description, 'Test description');
  assert.deepEqual(channelTask.links, [{ title: 'Site', url: 'https://example.com/channel' }]);
  assert.equal(channelTask.avatarPath, path.resolve(channelAvatarPath));
  assert.equal(channelTask.bannerPath, path.resolve(channelBannerPath));
  const channelTasks = await (await fetch(`${base}/api/channels/tasks`)).json();
  assert.equal(channelTasks.tasks.length, 1);
  const rejectedSingleChannelRequests = [
    { profileId: 'test-profile', links: [{ title: 'Bad', url: 'javascript:alert(1)' }] },
    { profileId: 'test-profile', links: [{ title: 'Credentials', url: 'https://user:pass@example.com' }] },
    { profileId: 'test-profile', avatarPath: channelAssetDirectory },
    { profileId: 'test-profile', name: 'Bad\u0001name' },
    { profileId: 'test-profile' },
  ];
  for (const body of rejectedSingleChannelRequests) {
    const rejected = await fetch(`${base}/api/channels/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal((await (await fetch(`${base}/api/channels/tasks`)).json()).tasks.length, 1);
  const runSingleChannel = await fetch(`${base}/api/channels/tasks/${channelTask.id}/run`, { method: 'POST' });
  assert.equal(runSingleChannel.status, 200);
  const manualLoginChannelTask = await runSingleChannel.json();
  assert.equal(manualLoginChannelTask.status, 'manual-login-required');
  assert.equal(manualLoginChannelTask.result, undefined);
  assert.ok(localDolphinCalls.some(call => call.profileId === 'test-profile'));
  const rerunSingleChannel = await fetch(`${base}/api/channels/tasks/${channelTask.id}/run`, { method: 'POST' });
  assert.equal(rerunSingleChannel.status, 200);
  assert.equal((await rerunSingleChannel.json()).status, 'manual-login-required');
  const failedChannelTaskResponse = await fetch(`${base}/api/channels/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: 'mock-start-failure', description: 'Failure transition test' }),
  });
  assert.equal(failedChannelTaskResponse.status, 201);
  const failedChannelTask = await failedChannelTaskResponse.json();
  const failedChannelRun = await fetch(`${base}/api/channels/tasks/${failedChannelTask.id}/run`, { method: 'POST' });
  assert.equal(failedChannelRun.status, 200);
  const failedChannelResult = await failedChannelRun.json();
  assert.equal(failedChannelResult.status, 'error');
  assert.ok(failedChannelResult.error);
  const retryFailedChannel = await fetch(`${base}/api/channels/tasks/${failedChannelTask.id}/run`, { method: 'POST' });
  assert.equal(retryFailedChannel.status, 200);
  assert.equal((await retryFailedChannel.json()).status, 'error');
  const bulkChannelResponse = await fetch(`${base}/api/channels/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileIds: ['channel-profile-a', ' channel-profile-b ', 'channel-profile-a'],
      name: 'Channel {index} for {profileId}',
      description: 'Description {index}: {profileId}',
      avatarPath: channelAvatarPath,
      bannerPath: channelBannerPath,
      links: [{ title: 'Website', url: 'https://example.com/channel' }],
    }),
  });
  assert.equal(bulkChannelResponse.status, 201);
  const bulkChannel = await bulkChannelResponse.json();
  assert.equal(bulkChannel.created, 2);
  assert.deepEqual(bulkChannel.profileIds, ['channel-profile-a', 'channel-profile-b']);
  assert.equal(bulkChannel.autoRun, false);
  assert.equal(bulkChannel.manualStartRequired, true);
  assert.equal(bulkChannel.batch.total, 2);
  assert.equal(bulkChannel.batch.queued, 2);
  assert.ok(bulkChannel.tasks.every(task => task.source === 'bulk-channel' && task.batchId === bulkChannel.batchId && task.status === 'queued' && task.autoRun === false));
  assert.deepEqual(bulkChannel.tasks.map(task => task.name), ['Channel 1 for channel-profile-a', 'Channel 2 for channel-profile-b']);
  assert.deepEqual(bulkChannel.tasks.map(task => task.description), ['Description 1: channel-profile-a', 'Description 2: channel-profile-b']);
  assert.ok(bulkChannel.tasks.every(task => task.avatarPath === path.resolve(channelAvatarPath)));
  assert.ok(bulkChannel.tasks.every(task => task.bannerPath === path.resolve(channelBannerPath)));
  assert.ok(bulkChannel.tasks.every(task => task.links.length === 1 && task.links[0].url === 'https://example.com/channel'));
  const channelBatches = await (await fetch(`${base}/api/channels/batches`)).json();
  assert.equal(channelBatches.batches.length, 1);
  assert.equal(channelBatches.batches[0].id, bulkChannel.batchId);
  assert.equal(channelBatches.batches[0].total, 2);
  const autoBulkChannelResponse = await fetch(`${base}/api/channels/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: ['channel-profile-auto'], description: 'Automatic channel {index}', autoRun: true }),
  });
  assert.equal(autoBulkChannelResponse.status, 201);
  const autoBulkChannel = await autoBulkChannelResponse.json();
  assert.equal(autoBulkChannel.autoRun, true);
  assert.equal(autoBulkChannel.manualStartRequired, false);
  assert.equal(autoBulkChannel.tasks[0].status, 'queued');
  const runAutoBulkChannel = await fetch(`${base}/api/channels/tasks/${autoBulkChannel.tasks[0].id}/run`, { method: 'POST' });
  assert.equal(runAutoBulkChannel.status, 200);
  assert.equal((await runAutoBulkChannel.json()).status, 'manual-login-required');
  const channelBatchesAfterRun = await (await fetch(`${base}/api/channels/batches`)).json();
  const autoRunBatch = channelBatchesAfterRun.batches.find(batch => batch.id === autoBulkChannel.batchId);
  assert.equal(autoRunBatch.manualLoginRequired, 1);
  assert.equal(autoRunBatch.completed, 0);
  const channelTaskCountBeforeRejectedBulk = (await (await fetch(`${base}/api/channels/tasks`)).json()).tasks.length;
  const rejectedChannelBulk = await fetch(`${base}/api/channels/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileIds: Array.from({ length: 101 }, (_, index) => `channel-${index}`),
      name: 'Over limit {index}',
    }),
  });
  assert.equal(rejectedChannelBulk.status, 400);
  const rejectedChannelLink = await fetch(`${base}/api/channels/tasks/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileIds: ['bad-link-profile'], links: [{ title: 'Bad', url: 'javascript:alert(1)' }] }),
  });
  assert.equal(rejectedChannelLink.status, 400);
  const channelTasksAfterRejectedBulk = await (await fetch(`${base}/api/channels/tasks`)).json();
  assert.equal(channelTasksAfterRejectedBulk.tasks.length, channelTaskCountBeforeRejectedBulk);
  const recoveryStatePath = path.join(testStateDir, 'recovery-state.json');
  fs.writeFileSync(recoveryStatePath, JSON.stringify({
    channelTasks: [{
      id: 'interrupted-channel-task',
      profileId: 'recovery-profile',
      name: 'Interrupted task',
      status: 'applying',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, {
      id: 'starting-channel-task',
      profileId: 'recovery-starting-profile',
      description: 'Interrupted before Studio opened',
      status: 'starting-profile',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, {
      id: 'queued-channel-task',
      profileId: 'recovery-queued-profile',
      description: 'Must remain queued after restart',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, {
      id: 'manual-channel-task',
      profileId: 'recovery-manual-profile',
      description: 'Manual login must remain actionable',
      status: 'manual-login-required',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    processingBatches: [{
      id: 'interrupted-processing-batch',
      status: 'running',
      concurrency: 1,
      autoRun: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        id: 'interrupted-processing-item',
        inputPath: bulkVideoPath,
        outputPath: processingOutputPath,
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }],
    mediaCampaigns: [{
      id: 'interrupted-campaign',
      name: 'Interrupted campaign',
      status: 'running',
      outputCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      assignments: [{
        id: 'interrupted-campaign-assignment',
        outputIndex: 1,
        sourceName: 'source',
        sourcePath: bulkVideoPath,
        outputPath: processingOutputPath,
        processingBatchId: 'interrupted-processing-batch',
        processingItemId: 'interrupted-processing-item',
        status: 'processing',
        message: 'FFmpeg was working',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }],
  }));
  const recoveryProbe = `
    import { once } from 'node:events';
    const previousLog = console.log;
    console.log = () => {};
    const { server } = await import('./server.js?recovery-probe=1');
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const [channelResponse, processingResponse, campaignResponse] = await Promise.all([
      fetch('http://127.0.0.1:' + address.port + '/api/channels/tasks'),
      fetch('http://127.0.0.1:' + address.port + '/api/processing/batches'),
      fetch('http://127.0.0.1:' + address.port + '/api/campaigns'),
    ]);
    const channelPayload = await channelResponse.json();
    const processingPayload = await processingResponse.json();
    const campaignPayload = await campaignResponse.json();
    const retryResponse = await fetch('http://127.0.0.1:' + address.port + '/api/channels/tasks/interrupted-channel-task/run', { method: 'POST' });
    const retryTask = await retryResponse.json();
    const finalChannelPayload = await (await fetch('http://127.0.0.1:' + address.port + '/api/channels/tasks')).json();
    const payload = { tasks: channelPayload.tasks, retryTask, finalTasks: finalChannelPayload.tasks, processing: processingPayload, campaigns: campaignPayload.campaigns };
    await new Promise(resolve => server.close(resolve));
    previousLog(JSON.stringify(payload));
  `;
  const recoveryProbeResult = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', recoveryProbe], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '0',
      CREATOR_FLOW_BACKGROUND: '0',
      CREATOR_FLOW_STATE_PATH: recoveryStatePath,
      CREATOR_FLOW_HOST: '127.0.0.1',
    },
  });
  const recoveredProbe = JSON.parse(recoveryProbeResult.stdout.trim());
  const recoveredChannelTasks = recoveredProbe.tasks;
  assert.equal(recoveredChannelTasks.length, 4);
  assert.equal(recoveredChannelTasks[0].status, 'recovery-needed');
  assert.equal(recoveredChannelTasks[1].status, 'recovery-needed');
  assert.equal(recoveredChannelTasks[2].status, 'queued');
  assert.equal(recoveredChannelTasks[3].status, 'manual-login-required');
  assert.match(recoveredChannelTasks[0].message, /прервано перезапуском/i);
  assert.equal(recoveredProbe.processing.batches.length, 1);
  assert.equal(recoveredProbe.processing.batches[0].status, 'needs-attention');
  assert.equal(recoveredProbe.processing.batches[0].items[0].status, 'recovery-needed');
  assert.equal(recoveredProbe.campaigns.length, 1);
  assert.equal(recoveredProbe.campaigns[0].status, 'needs-attention');
  assert.equal(recoveredProbe.campaigns[0].assignments[0].status, 'recovery-needed');
  assert.equal(recoveredProbe.retryTask.status, 'manual-login-required');
  assert.equal(recoveredProbe.finalTasks.find(task => task.id === 'interrupted-channel-task').status, 'manual-login-required');
  assert.ok(localDolphinCalls.some(call => call.profileId === 'recovery-profile'));
  const invalidLibraryUpload = await fetch(`${base}/api/library/upload?name=broken.mp4`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('not a media file'),
  });
  assert.equal(invalidLibraryUpload.status, 422);
  const isolatedLibraryDir = path.join(testStateDir, 'library');
  assert.deepEqual(fs.readdirSync(isolatedLibraryDir).filter(name => name.endsWith('.uploading')), []);
  const uniqueizer = await (await fetch(`${base}/api/uniqueizer/health`)).json();
  assert.equal(typeof uniqueizer.available, 'boolean');
  if (uniqueizer.available) {
    const execFileAsync = promisify(execFile);
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.2', '-c:v', 'libx264', inputPath]);
    const streamedUpload = await fetch(`${base}/api/library/upload?name=streamed-input.mp4`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: fs.createReadStream(inputPath),
      duplex: 'half',
    });
    assert.equal(streamedUpload.status, 201);
    const streamedItem = (await streamedUpload.json()).item;
    assert.equal(streamedItem.source, 'uploaded');
    assert.equal(streamedItem.hasVideo, true);
    assert.ok(fs.existsSync(streamedItem.filePath));
    const noProfilesCampaignResponse = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath],
        outputCount: 2,
        outputFolder: testStateDir,
        outputTemplate: 'campaign-{index}.mp4',
        recipe: { layout: 'keep', crop: 'none', speedMin: 0.98, speedMax: 1.02, audioMode: 'original', metadataMode: 'clean', addToLibrary: false },
        profileIds: [],
        distributionEnabled: false,
        titleTemplate: '',
        descriptionTemplate: '',
        tags: [],
        autoStart: false,
        processingConcurrency: 2,
        uploadConcurrency: 1,
      }),
    });
    assert.equal(noProfilesCampaignResponse.status, 201);
    const noProfilesCampaign = (await noProfilesCampaignResponse.json()).campaign;
    assert.equal(noProfilesCampaign.outputCount, 2);
    assert.equal(noProfilesCampaign.distributionEnabled, false);
    assert.deepEqual(noProfilesCampaign.profileIds, []);
    assert.equal(noProfilesCampaign.assignments.length, 2);
    assert.ok(noProfilesCampaign.assignments.every(item => item.status === 'queued' && item.recipe?.recipeId));
    assert.notEqual(noProfilesCampaign.assignments[0].recipe.renderSignature, noProfilesCampaign.assignments[1].recipe.renderSignature);
    const presetCatalogue = await (await fetch(`${base}/api/uniqueizer/presets`)).json();
    assert.deepEqual(
      presetCatalogue.presets.map(preset => preset.id),
      ['manual', 'shorts-balanced', 'soft-editorial', 'square-stories'],
    );
    const presetCampaignResponse = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath],
        outputCount: 10,
        outputFolder: testStateDir,
        outputTemplate: 'campaign-preset-{index}.mp4',
        presetId: 'shorts-balanced',
        recipe: {
          presetId: 'shorts-balanced',
          textVariations: [],
          audioMode: 'original',
          metadataMode: 'clean',
          addToLibrary: false,
        },
        distributionEnabled: false,
        profileIds: [],
        autoStart: false,
        processingConcurrency: 1,
        uploadConcurrency: 1,
      }),
    });
    assert.equal(presetCampaignResponse.status, 201);
    const presetCampaign = (await presetCampaignResponse.json()).campaign;
    assert.equal(presetCampaign.presetId, 'shorts-balanced');
    assert.equal(presetCampaign.assignments.length, 10);
    assert.equal(new Set(presetCampaign.assignments.map(item => item.recipe.renderSignature)).size, 10);
    assert.ok(presetCampaign.assignments.every(item => item.recipe.edits.crop?.aspect === '9:16'));
    assert.ok(presetCampaign.assignments.every(item => item.recipe.edits.video?.fps));
    assert.deepEqual(presetCampaign.duplicateRenderGroups, []);
    const invalidPresetCampaign = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath], outputCount: 1, outputFolder: testStateDir,
        outputTemplate: 'invalid-preset-{index}.mp4', presetId: 'not-a-preset', distributionEnabled: false,
      }),
    });
    assert.equal(invalidPresetCampaign.status, 422);
    assert.equal((await invalidPresetCampaign.json()).code, 'campaign-preset-invalid');
    const collidingCampaign = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath], outputCount: 2, outputFolder: testStateDir, outputTemplate: 'campaign-{index}.mp4',
        recipe: { layout: 'keep', crop: 'none', speedMin: 0.98, speedMax: 1.02, audioMode: 'original', metadataMode: 'clean' },
        distributionEnabled: false,
      }),
    });
    assert.equal(collidingCampaign.status, 409);
    assert.equal((await collidingCampaign.json()).code, 'campaign-output-reserved');
    const campaignList = await (await fetch(`${base}/api/campaigns`)).json();
    assert.ok(campaignList.campaigns.some(campaign => campaign.id === noProfilesCampaign.id));
    assert.ok(campaignList.campaigns.some(campaign => campaign.id === presetCampaign.id));
    const invalidCampaignRecipe = await fetch(`${base}/api/campaigns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath], outputCount: 1, outputFolder: testStateDir, outputTemplate: 'invalid-{index}.mp4',
        recipe: { metadataMode: 'keep' }, distributionEnabled: false,
      }),
    });
    assert.equal(invalidCampaignRecipe.status, 422);
    const runCampaignResponse = await fetch(`${base}/api/campaigns/${noProfilesCampaign.id}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(runCampaignResponse.status, 202);
    let renderedCampaign = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      renderedCampaign = (await (await fetch(`${base}/api/campaigns/${noProfilesCampaign.id}`)).json()).campaign;
      if (renderedCampaign.status === 'completed' || renderedCampaign.status === 'needs-attention') break;
    }
    assert.equal(renderedCampaign.status, 'completed');
    assert.ok(fs.existsSync(campaignOutputOne));
    assert.ok(fs.existsSync(campaignOutputTwo));
    assert.ok(renderedCampaign.assignments.every(item => item.status === 'completed'));

    // A real local render through the complete visual-editorial path.  This
    // remains inside the isolated state directory: no Dolphin profile,
    // browser, user library or user media is accessed by this test.
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white@0.7:s=32x32:d=0.1',
      '-vf', 'format=rgba', '-frames:v', '1', campaignOverlayPath,
    ]);
    const visualCampaignResponse = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath],
        outputCount: 1,
        outputFolder: testStateDir,
        outputTemplate: 'campaign-visual-{index}.mp4',
        recipe: {
          layout: 'keep', crop: 'none', speedMin: 1, speedMax: 1,
          overlayPath: campaignOverlayPath, overlayOpacity: 0.65, overlayPosition: 'top-left', overlayWidth: 32,
          overlayBlurMin: 2, overlayBlurMax: 2,
          textVariations: ['Проверка: видимый текст'],
          fontPath: 'C:\\Windows\\Fonts\\arial.ttf', textSize: 20, textY: 75, textColorMode: 'accent', textOutline: true,
          fps: 24, bitrateKbps: 700,
          colorCorrectionEnabled: true, colorStrength: 45,
          audioMode: 'original', metadataMode: 'clean', addToLibrary: false,
        },
        distributionEnabled: false, profileIds: [], autoStart: false,
        processingConcurrency: 1, uploadConcurrency: 1,
      }),
    });
    assert.equal(visualCampaignResponse.status, 201);
    const visualCampaign = (await visualCampaignResponse.json()).campaign;
    const visualRecipe = visualCampaign.assignments[0].recipe;
    assert.equal(visualRecipe.edits.text.value, 'Проверка: видимый текст');
    assert.equal(visualRecipe.edits.text.yPercent, 75);
    assert.equal(visualRecipe.edits.overlay.position, 'top-left');
    assert.ok(visualRecipe.edits.overlay.blur > 0);
    assert.equal(visualRecipe.edits.color.amount, 45);
    assert.equal(visualRecipe.edits.video.fps, 24);
    assert.equal(visualRecipe.edits.video.bitrateKbps, 700);
    assert.ok(visualRecipe.materialChanges.some(change => change.startsWith('text-')));
    const visualRun = await fetch(`${base}/api/campaigns/${visualCampaign.id}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(visualRun.status, 202);
    let renderedVisualCampaign = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      renderedVisualCampaign = (await (await fetch(`${base}/api/campaigns/${visualCampaign.id}`)).json()).campaign;
      if (renderedVisualCampaign.status === 'completed' || renderedVisualCampaign.status === 'needs-attention') break;
    }
    assert.equal(renderedVisualCampaign.status, 'completed', JSON.stringify(renderedVisualCampaign.assignments[0]));
    assert.ok(fs.existsSync(campaignVisualOutput));
    assert.equal(renderedVisualCampaign.assignments[0].status, 'completed');

    // This covers the full named-preset path as well: it resolves an explicit
    // vertical recipe on the server and renders it locally through FFmpeg.
    const presetRenderResponse = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourcePaths: [streamedItem.filePath],
        outputCount: 1,
        outputFolder: testStateDir,
        outputTemplate: 'campaign-preset-render-{index}.mp4',
        presetId: 'shorts-balanced',
        recipe: { presetId: 'shorts-balanced', audioMode: 'original', metadataMode: 'clean', addToLibrary: false },
        distributionEnabled: false,
        profileIds: [],
        autoStart: false,
        processingConcurrency: 1,
        uploadConcurrency: 1,
      }),
    });
    assert.equal(presetRenderResponse.status, 201);
    const presetRenderCampaign = (await presetRenderResponse.json()).campaign;
    assert.equal(presetRenderCampaign.assignments[0].recipe.edits.crop.aspect, '9:16');
    const presetRun = await fetch(`${base}/api/campaigns/${presetRenderCampaign.id}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(presetRun.status, 202);
    let renderedPresetCampaign = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      renderedPresetCampaign = (await (await fetch(`${base}/api/campaigns/${presetRenderCampaign.id}`)).json()).campaign;
      if (renderedPresetCampaign.status === 'completed' || renderedPresetCampaign.status === 'needs-attention') break;
    }
    assert.equal(renderedPresetCampaign.status, 'completed', JSON.stringify(renderedPresetCampaign.assignments[0]));
    assert.ok(fs.existsSync(campaignPresetRenderOutput));
    assert.equal(renderedPresetCampaign.assignments[0].status, 'completed');
    const invalidProcessingBatch = await fetch(`${base}/api/processing/batches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [{ inputPath: streamedItem.filePath, outputPath: path.join(testStateDir, 'not-an-mp4.mov') }] }),
    });
    assert.equal(invalidProcessingBatch.status, 400);
    const processingBatchResponse = await fetch(`${base}/api/processing/batches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobs: [{ inputPath: streamedItem.filePath, outputPath: processingOutputPath }], concurrency: 1, autoRun: false }),
    });
    assert.equal(processingBatchResponse.status, 201);
    const processingBatch = await processingBatchResponse.json();
    assert.equal(processingBatch.batch.total, 1);
    assert.equal(processingBatch.batch.status, 'queued');
    assert.equal(processingBatch.batch.autoRun, false);
    assert.equal(processingBatch.batch.items[0].status, 'queued');
    assert.equal(processingBatch.processor.limit, 3);
    const processingBatches = await (await fetch(`${base}/api/processing/batches`)).json();
    assert.ok(processingBatches.batches.length >= 2);
    const standaloneProcessingBatch = processingBatches.batches.find(batch => batch.id === processingBatch.batch.id);
    assert.equal(standaloneProcessingBatch.items[0].outputPath, processingOutputPath);
    const startedProcessingBatch = await fetch(`${base}/api/processing/batches/${processingBatch.batch.id}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(startedProcessingBatch.status, 202);
    assert.equal((await startedProcessingBatch.json()).batch.autoRun, true);
    const render = await (await fetch(`${base}/api/uniqueizer/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputPath: streamedItem.filePath, outputPath }) })).json();
    assert.equal(render.status, 'completed'); assert.ok(fs.existsSync(outputPath));
    const imported = await (await fetch(`${base}/api/library/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: outputPath }) })).json();
    assert.equal(imported.item.hasVideo, true);
    const library = await (await fetch(`${base}/api/library`)).json();
    assert.equal(library.library.length, 2);
  }
  console.log('API smoke test passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => dolphinMock.close(resolve));
  await new Promise(resolve => localDolphinMock.close(resolve));
  fs.rmSync(inputPath, { force: true });
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(processingOutputPath, { force: true });
  fs.rmSync(campaignOutputOne, { force: true });
  fs.rmSync(campaignOutputTwo, { force: true });
  fs.rmSync(campaignVisualOutput, { force: true });
  fs.rmSync(campaignOverlayPath, { force: true });
  fs.rmSync(bulkVideoPath, { force: true });
  fs.rmSync(channelAvatarPath, { force: true });
  fs.rmSync(channelBannerPath, { force: true });
  fs.rmSync(channelAssetDirectory, { recursive: true, force: true });
  fs.rmSync(testStateDir, { recursive: true, force: true });
  if (productionHashBefore !== null) {
    const productionHashAfter = crypto.createHash('sha256').update(fs.readFileSync(productionStatePath)).digest('hex');
    assert.equal(productionHashAfter, productionHashBefore, 'Тест не должен менять пользовательский файл состояния.');
  }
}
