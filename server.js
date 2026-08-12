import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDolphinClient } from './dolphin-client.js';
import { uploadOwnVideo } from './upload-worker.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const apiBase = process.env.DOLPHIN_API_BASE || 'https://anty-api.com';
const localApi = process.env.DOLPHIN_LOCAL_API || 'http://localhost:3001';
const token = process.env.DOLPHIN_API_TOKEN;
const dolphinClient = createDolphinClient({ baseUrl: apiBase, token });
const tasks = [];
const proxies = [];
const videos = [];
const logs = [];
const execFileAsync = promisify(execFile);
const statePath = path.join(root, '.creator-flow-state.json');
try { const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); tasks.push(...(saved.tasks || [])); proxies.push(...(saved.proxies || [])); videos.push(...(saved.videos || [])); } catch {}
function saveState() { fs.writeFileSync(statePath, JSON.stringify({ tasks, proxies, videos }, null, 2)); }
function addLog(message, taskId = null, level = 'info') { logs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), taskId, level, message }); if (logs.length > 500) logs.pop(); }
async function startQueuedTask(task) {
  if (task.status !== 'queued') return task;
  task.status = 'starting-profile'; task.updatedAt = new Date().toISOString(); addLog(`Запуск запланированной задачи для профиля ${task.profileId}`, task.id);
  try {
    task.profileResult = await dolphinClient.startProfile(task.profileId);
    const payload = task.profileResult?.data || task.profileResult;
    task.wsEndpoint = payload?.wsEndpoint || payload?.automation?.wsEndpoint || payload?.remoteDebuggingAddress || payload?.remote_debugging_address || null;
    task.status = 'profile-ready'; task.message = 'Профиль запущен. Готов к браузерному этапу публикации.';
    addLog(`Профиль запущен${task.wsEndpoint ? ', адрес браузера получен' : ', адрес браузера не найден в ответе API'}`, task.id, task.wsEndpoint ? 'info' : 'warn');
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка запуска профиля: ${error.message}`, task.id, 'error'); }
  task.updatedAt = new Date().toISOString(); saveState(); return task;
}
async function processScheduledTasks() {
  const now = Date.now();
  for (const task of tasks) if (task.status === 'queued' && task.scheduledAt && Date.parse(task.scheduledAt) <= now) await startQueuedTask(task);
}
const scheduler = setInterval(() => { processScheduledTasks().catch(error => addLog(`Ошибка планировщика: ${error.message}`, null, 'error')); }, 5000);
scheduler.unref();

app.use(express.json());
app.use(express.static(root));

async function dolphin(pathname, options = {}) {
  if (!token) throw new Error('DOLPHIN_API_TOKEN не настроен локально');
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...options.headers }
  });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!response.ok) throw new Error(body.message || `Dolphin API: ${response.status}`);
  return body;
}

app.get('/api/health', async (_req, res) => {
  try {
    const response = await fetch(localApi, { signal: AbortSignal.timeout(2000) });
    res.json({ configured: Boolean(token), localApi, localRunning: response.ok });
  } catch { res.json({ configured: Boolean(token), localApi, localRunning: false }); }
});

app.get('/api/profiles', async (_req, res) => {
  try {
    const result = await dolphinClient.listProfiles();
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/start', async (req, res) => {
  try {
    const result = await dolphinClient.startProfile(req.params.id);
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/stop', async (req, res) => {
  try {
    const result = await dolphinClient.stopProfile(req.params.id);
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/tasks', (_req, res) => res.json({ tasks }));
app.get('/api/logs', (_req, res) => res.json({ logs: logs.slice(0, 200) }));
app.get('/api/videos', (_req, res) => res.json({ videos }));
app.get('/api/videos/stats', (_req, res) => {
  const stats = videos.reduce((acc, video) => ({ count: acc.count + 1, views: acc.views + Number(video.views || 0), likes: acc.likes + Number(video.likes || 0), comments: acc.comments + Number(video.comments || 0), zeroViews: acc.zeroViews + (Number(video.views || 0) === 0 ? 1 : 0), over300: acc.over300 + (Number(video.views || 0) >= 300 ? 1 : 0), unavailable: acc.unavailable + (video.status === 'unavailable' ? 1 : 0) }), { count: 0, views: 0, likes: 0, comments: 0, zeroViews: 0, over300: 0, unavailable: 0 });
  res.json(stats);
});
app.post('/api/videos', (req, res) => {
  const { title, videoPath, profileId, publishedAt = null, views = 0, likes = 0, comments = 0 } = req.body || {};
  if (!title || !videoPath || !profileId) return res.status(400).json({ error: 'title, videoPath и profileId обязательны' });
  const video = { id: crypto.randomUUID(), title, videoPath, profileId, publishedAt, views: Number(views), likes: Number(likes), comments: Number(comments), status: 'published', createdAt: new Date().toISOString() };
  videos.push(video); saveState(); addLog(`Видео добавлено в реестр: ${title}`); res.status(201).json(video);
});
app.patch('/api/videos/:id/stats', (req, res) => {
  const video = videos.find(item => item.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  for (const key of ['views', 'likes', 'comments']) if (req.body?.[key] !== undefined) video[key] = Math.max(0, Number(req.body[key]) || 0);
  if (req.body?.status) video.status = String(req.body.status);
  video.updatedAt = new Date().toISOString(); saveState(); res.json(video);
});

app.get('/api/proxies', (_req, res) => res.json({ proxies: proxies.map(({ password, ...safe }) => safe) }));

app.post('/api/proxies/import', (req, res) => {
  const lines = String(req.body?.text || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const imported = lines.map((line, index) => {
    const parts = line.split(':');
    const [host, port, username = '', password = ''] = parts;
    return { id: crypto.randomUUID(), host, port: Number(port), username, password, type: req.body?.type || 'http', status: 'unverified', sourceLine: index + 1 };
  }).filter(item => item.host && Number.isInteger(item.port) && item.port > 0 && item.port < 65536);
  proxies.push(...imported);
  saveState();
  res.status(201).json({ imported: imported.length, invalid: lines.length - imported.length, proxies: imported.map(({ password, ...safe }) => safe) });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (task.status === 'running') return res.status(409).json({ error: 'Задача уже выполняется' });
  res.json(await startQueuedTask(task));
});

app.post('/api/tasks/:id/upload', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  const wsEndpoint = req.body?.wsEndpoint || task.wsEndpoint || task.profileResult?.wsEndpoint || task.profileResult?.automation?.wsEndpoint;
  task.status = 'uploading'; task.updatedAt = new Date().toISOString(); addLog('Начата загрузка ролика в браузере профиля', task.id);
  try {
    task.uploadResult = await uploadOwnVideo({ wsEndpoint, videoPath: task.videoPath, title: task.title, description: task.description, tags: task.tags });
    task.status = 'awaiting-review';
    addLog('Видео загружено в форму и ожидает ручной проверки', task.id);
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка загрузки: ${error.message}`, task.id, 'error'); }
  task.updatedAt = new Date().toISOString();
  saveState();
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const { profileId, videoPath, title, description = '', tags = [], scheduledAt = null } = req.body || {};
  if (!profileId || !videoPath || !title) return res.status(400).json({ error: 'profileId, videoPath и title обязательны' });
  const task = { id: crypto.randomUUID(), profileId, videoPath, title, description, tags, scheduledAt, status: 'queued', createdAt: new Date().toISOString() };
  tasks.push(task);
  saveState();
  res.status(201).json(task);
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
  saveState();
  res.json(task);
});

app.get('/api/uniqueizer/health', async (_req, res) => {
  try { const result = await execFileAsync('ffmpeg', ['-version']); res.json({ available: true, version: result.stdout.split('\n')[0] }); }
  catch { res.json({ available: false, message: 'FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.' }); }
});

app.post('/api/uniqueizer/render', async (req, res) => {
  const { inputPath, outputPath, overlayPath } = req.body || {};
  if (!inputPath || !outputPath) return res.status(400).json({ error: 'inputPath и outputPath обязательны' });
  const args = ['-y', '-i', inputPath];
  if (overlayPath) args.push('-i', overlayPath, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto');
  args.push('-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', outputPath);
  try { await execFileAsync('ffmpeg', args, { windowsHide: true }); res.status(201).json({ status: 'completed', outputPath }); }
  catch (error) { res.status(422).json({ status: 'error', error: error.message, hint: 'Установите FFmpeg и проверьте пути к файлам.' }); }
});

const server = app.listen(Number(process.env.PORT || 3030), () => console.log(`Creator Flow: http://localhost:${process.env.PORT || 3030}`));
export { app, server };
