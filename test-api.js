import assert from 'node:assert/strict';
process.env.PORT = '0';
const { server } = await import('./server.js');
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(typeof health.configured, 'boolean');
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(Array.isArray(tasks.tasks));
  const proxies = await (await fetch(`${base}/api/proxies`)).json();
  assert.ok(Array.isArray(proxies.proxies));
  const importResult = await (await fetch(`${base}/api/proxies/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'http', text: '# test\n127.0.0.1:8080\ninvalid' }) })).json();
  assert.equal(importResult.imported, 1);
  const uniqueizer = await (await fetch(`${base}/api/uniqueizer/health`)).json();
  assert.equal(typeof uniqueizer.available, 'boolean');
  console.log('API smoke test passed');
} finally { server.close(); }
