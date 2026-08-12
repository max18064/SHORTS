import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const channelTask = await (await fetch(`${base}/api/channels/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: 'test-profile', name: 'Test channel', description: 'Test description', links: [{ title: 'Site', url: 'https://example.com' }] }) })).json();
  assert.equal(channelTask.status, 'queued');
  const channelTasks = await (await fetch(`${base}/api/channels/tasks`)).json();
  assert.equal(channelTasks.tasks.length, 1);
  const uniqueizer = await (await fetch(`${base}/api/uniqueizer/health`)).json();
  assert.equal(typeof uniqueizer.available, 'boolean');
  if (uniqueizer.available) {
    const execFileAsync = promisify(execFile);
    const inputPath = path.join(process.cwd(), '.test-input.mp4');
    const outputPath = path.join(process.cwd(), '.test-output.mp4');
    await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.2', '-c:v', 'libx264', inputPath]);
    const render = await (await fetch(`${base}/api/uniqueizer/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputPath, outputPath }) })).json();
    assert.equal(render.status, 'completed'); assert.ok(fs.existsSync(outputPath));
    fs.unlinkSync(inputPath); fs.unlinkSync(outputPath);
  }
  console.log('API smoke test passed');
} finally { server.close(); try { fs.unlinkSync(process.env.CREATOR_FLOW_STATE_PATH); } catch {} }
