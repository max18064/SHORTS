import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.PORT = '0';
process.env.CREATOR_FLOW_STATE_PATH = path.join(process.cwd(), '.test-state.json');
try { fs.unlinkSync(process.env.CREATOR_FLOW_STATE_PATH); } catch {}
const { server } = await import('./server.js');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(typeof health.configured, 'boolean');
  assert.equal(typeof health.remoteApi, 'boolean');
  const profiles = await (await fetch(`${base}/api/profiles`)).json();
  assert.ok(profiles.data || profiles.error);
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(Array.isArray(tasks.tasks));
  const proxies = await (await fetch(`${base}/api/proxies`)).json();
  assert.ok(Array.isArray(proxies.proxies));
  const importResult = await (await fetch(`${base}/api/proxies/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'http', text: '# test\n127.0.0.1:8080\ninvalid' }) })).json();
  assert.equal(importResult.imported, 1);
  const createdVideo = await (await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Smoke test', videoPath: 'C:/test.mp4', profileId: 'test-profile', views: 301 }) })).json();
  assert.equal(createdVideo.status, 'published');
  const stats = await (await fetch(`${base}/api/videos/stats`)).json();
  assert.ok(stats.count >= 1 && stats.over300 >= 1);
  const uniqueizer = await (await fetch(`${base}/api/uniqueizer/health`)).json();
  assert.equal(typeof uniqueizer.available, 'boolean');
  console.log('API smoke test passed');
} finally { server.close(); try { fs.unlinkSync(process.env.CREATOR_FLOW_STATE_PATH); } catch {} }
