import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDolphinClient } from './dolphin-client.js';
import { openUploadSession, uploadIntoSession, uploadOwnVideo } from './upload-worker.js';
import { inspectChannel, updateChannelBranding } from './channel-worker.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const apiBase = process.env.DOLPHIN_API_BASE || 'https://anty-api.com';
const localApi = process.env.DOLPHIN_LOCAL_API || 'http://localhost:3001';
const token = process.env.DOLPHIN_API_TOKEN;
const dolphinAutomation = process.env.DOLPHIN_AUTOMATION !== '0';
const dolphinClient = createDolphinClient({ baseUrl: apiBase, token, automation: dolphinAutomation });
const tasks = [];
const proxies = [];
const videos = [];
const channelTasks = [];
const logs = [];
const uploadSessions = new Map();
const execFileAsync = promisify(execFile);
const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
const statePath = process.env.CREATOR_FLOW_STATE_PATH || path.join(root, '.creator-flow-state.json');
try { const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); tasks.push(...(saved.tasks || [])); proxies.push(...(saved.proxies || [])); videos.push(...(saved.videos || [])); channelTasks.push(...(saved.channelTasks || [])); } catch {}
function saveState() { fs.writeFileSync(statePath, JSON.stringify({ tasks, proxies, videos, channelTasks }, null, 2)); }
function addLog(message, taskId = null, level = 'info') { logs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), taskId, level, message }); if (logs.length > 500) logs.pop(); }
function getAutomationEndpoint(result) {
  const payload = result?.data || result || {};
  const automation = payload.automation || {};
  const candidate = payload.wsEndpoint || automation.wsEndpoint || payload.remoteDebuggingAddress || payload.remote_debugging_address || payload.debuggerAddress || payload.debugger_address;
  if (candidate && String(candidate).startsWith('/devtools/') && automation.port) return `ws://127.0.0.1:${automation.port}${candidate}`;
  if (candidate) return String(candidate).startsWith('ws') ? candidate : `http://${candidate}`;
  if (automation.port) return `http://127.0.0.1:${automation.port}`;
  if (payload.selenium_port) return `http://127.0.0.1:${payload.selenium_port}`;
  return null;
}
async function localDolphin(action, id, automation = false) {
  const query = automation ? '?automation=1' : '';
  const response = await fetch(`${localApi}/v1.0/browser_profiles/${encodeURIComponent(id)}/${action}${query}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `Локальный Dolphin API: ${response.status}`);
  return data;
}
async function startQueuedTask(task) {
  if (task.status !== 'queued') return task;
  task.status = 'starting-profile'; task.updatedAt = new Date().toISOString(); addLog(`Запуск запланированной задачи для профиля ${task.profileId}`, task.id);
  try {
    task.profileResult = await localDolphin('start', task.profileId, dolphinAutomation);
    task.wsEndpoint = getAutomationEndpoint(task.profileResult);
    task.status = task.wsEndpoint ? 'profile-ready' : 'manual-login-required';
    task.message = task.wsEndpoint ? 'Профиль запущен. Готов к браузерному этапу публикации.' : 'Профиль запущен. Выполните ручной вход; для браузерного этапа нужен тариф Dolphin с Automation API.';
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
  let remoteApi = false;
  if (token) { try { await dolphinClient.listProfiles(); remoteApi = true; } catch {} }
  try {
    const response = await fetch(localApi, { signal: AbortSignal.timeout(2000) });
    res.json({ configured: Boolean(token), remoteApi, localApi, localRunning: response.ok });
  } catch { res.json({ configured: Boolean(token), remoteApi, localApi, localRunning: false }); }
});

app.get('/api/profiles', async (_req, res) => {
  try {
    const result = await dolphinClient.listProfiles();
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/start', async (req, res) => {
  try {
    const result = await localDolphin('start', req.params.id, dolphinAutomation);
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/stop', async (req, res) => {
  try {
    const result = await localDolphin('stop', req.params.id);
    res.json(result);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/youtube-status', async (req, res) => {
  try {
    let profileResult;
    try { profileResult = await localDolphin('start', req.params.id, dolphinAutomation); }
    catch (error) {
      if (!/already running/i.test(error.message) || req.body?.restart !== true) throw error;
      await localDolphin('stop', req.params.id);
      await new Promise(resolve => setTimeout(resolve, 1200));
      profileResult = await localDolphin('start', req.params.id, dolphinAutomation);
    }
    const wsEndpoint = getAutomationEndpoint(profileResult);
    const channel = wsEndpoint ? await inspectChannel({ wsEndpoint }) : { status: 'automation-unavailable' };
    addLog(`Проверка YouTube-профиля ${req.params.id}: ${channel.status}`);
    res.json({ profileId: req.params.id, channel });
  } catch (error) {
    if (/already running/i.test(error.message)) return res.status(409).json({ error: 'Профиль уже запущен вне Creator Flow. Для чтения данных нажмите «Перезапустить и считать»: Dolphin перезапустит только этот профиль с Automation API.', code: 'profile-already-running' });
    res.status(422).json({ error: error.message });
  }
});

app.get('/api/tasks', (_req, res) => res.json({ tasks }));
app.get('/api/logs', (_req, res) => res.json({ logs: logs.slice(0, 200) }));
app.get('/api/videos', (_req, res) => res.json({ videos }));
app.get('/api/channels/tasks', (_req, res) => res.json({ tasks: channelTasks }));
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
  const wsEndpoint = req.body?.wsEndpoint || task.wsEndpoint || getAutomationEndpoint(task.profileResult);
  task.status = 'uploading'; task.updatedAt = new Date().toISOString(); addLog('Начата загрузка ролика в браузере профиля', task.id);
  try {
    task.uploadResult = await uploadOwnVideo({ wsEndpoint, videoPath: task.videoPath, title: task.title, description: task.description, tags: task.tags });
    task.status = task.uploadResult.status === 'manual-login-required' ? 'manual-login-required' : 'awaiting-review';
    addLog('Видео загружено в форму и ожидает ручной проверки', task.id);
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка загрузки: ${error.message}`, task.id, 'error'); }
  task.updatedAt = new Date().toISOString();
  saveState();
  res.json(task);
});

app.post('/api/tasks/:id/prepare-login', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  const wsEndpoint = task.wsEndpoint || getAutomationEndpoint(task.profileResult);
  try {
    const session = await openUploadSession({ wsEndpoint });
    uploadSessions.set(task.id, session); task.status = session.needsLogin ? 'manual-login-required' : 'login-ready'; task.updatedAt = new Date().toISOString();
    addLog(session.needsLogin ? 'Открыт YouTube: требуется ручной вход' : 'Профиль уже авторизован в YouTube', task.id, session.needsLogin ? 'warn' : 'info'); saveState(); res.json({ task, needsLogin: session.needsLogin });
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка открытия YouTube: ${error.message}`, task.id, 'error'); saveState(); res.status(422).json(task); }
});

app.post('/api/tasks/:id/upload/continue', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id); const session = uploadSessions.get(req.params.id);
  if (!task || !session) return res.status(404).json({ error: 'Сессия ручного входа не найдена' });
  try {
    const result = await uploadIntoSession({ session, videoPath: task.videoPath, title: task.title, description: task.description, tags: task.tags });
    if (result.status === 'manual-login-required') return res.status(409).json({ error: 'Вход ещё не выполнен', task });
    await session.browser.close(); uploadSessions.delete(task.id); task.uploadResult = result; task.status = 'awaiting-review'; task.updatedAt = new Date().toISOString(); addLog('Ручной вход подтверждён, видео загружено в форму', task.id); saveState(); res.json(task);
  } catch (error) { await session.browser.close().catch(() => {}); uploadSessions.delete(task.id); task.status = 'error'; task.error = error.message; addLog(`Ошибка продолжения загрузки: ${error.message}`, task.id, 'error'); saveState(); res.status(422).json(task); }
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

app.post('/api/channels/tasks', (req, res) => {
  const { profileId, name = '', description = '', links = [], avatarPath = '', bannerPath = '' } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId обязателен' });
  const safeLinks = Array.isArray(links) ? links.filter(link => link && typeof link.title === 'string' && typeof link.url === 'string') : [];
  if (!name && !description && !safeLinks.length && !avatarPath && !bannerPath) return res.status(400).json({ error: 'Укажите хотя бы одно изменение оформления канала' });
  const task = { id: crypto.randomUUID(), profileId, name, description, links: safeLinks, avatarPath, bannerPath, status: 'queued', createdAt: new Date().toISOString() };
  channelTasks.unshift(task); saveState(); addLog(`Задача оформления канала создана для профиля ${profileId}`, task.id); res.status(201).json(task);
});

app.post('/api/channels/tasks/:id/run', async (req, res) => {
  const task = channelTasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача оформления канала не найдена' });
  task.status = 'starting-profile'; task.updatedAt = new Date().toISOString(); saveState();
  try {
    const profileResult = await localDolphin('start', task.profileId, dolphinAutomation);
    const wsEndpoint = getAutomationEndpoint(profileResult);
    if (!wsEndpoint) { task.status = 'manual-login-required'; task.message = 'Профиль открыт. Выполните ручной вход в YouTube, затем запустите задачу повторно.'; }
    else {
      task.status = 'applying'; saveState();
      task.result = await updateChannelBranding({ wsEndpoint, name: task.name, description: task.description, links: task.links, avatarPath: task.avatarPath, bannerPath: task.bannerPath });
      task.status = task.result.status === 'manual-login-required' ? 'manual-login-required' : 'completed';
      task.message = task.status === 'completed' ? 'Оформление канала обновлено.' : 'Выполните ручной вход в YouTube в открытом профиле и повторите запуск.';
    }
    addLog(`Оформление канала: ${task.status}`, task.id, task.status === 'completed' ? 'info' : 'warn');
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка оформления канала: ${error.message}`, task.id, 'error'); }
  task.updatedAt = new Date().toISOString(); saveState(); res.json(task);
});

app.get('/api/uniqueizer/health', async (_req, res) => {
  try { const result = await execFileAsync(ffmpegBin, ['-version']); res.json({ available: true, path: ffmpegBin, version: result.stdout.split('\n')[0] }); }
  catch { res.json({ available: false, message: 'FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.' }); }
});

app.post('/api/uniqueizer/render', async (req, res) => {
  const { inputPath, outputPath, overlayPath } = req.body || {};
  if (!inputPath || !outputPath) return res.status(400).json({ error: 'inputPath и outputPath обязательны' });
  const args = ['-y', '-i', inputPath];
  if (overlayPath) args.push('-i', overlayPath, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto');
  args.push('-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', outputPath);
  try { await execFileAsync(ffmpegBin, args, { windowsHide: true }); res.status(201).json({ status: 'completed', outputPath }); }
  catch (error) { res.status(422).json({ status: 'error', error: error.message, hint: 'Установите FFmpeg и проверьте пути к файлам.' }); }
});

const server = app.listen(Number(process.env.PORT || 3030), () => console.log(`Creator Flow: http://localhost:${process.env.PORT || 3030}`));
export { app, server };
