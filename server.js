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
import { readStudioVideos } from './studio-reader.js';
import { inspectMediaFile } from './media-inspector.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const apiBase = process.env.DOLPHIN_API_BASE || 'https://anty-api.com';
const localApi = process.env.DOLPHIN_LOCAL_API || 'http://localhost:3001';
const token = process.env.DOLPHIN_API_TOKEN;
const dolphinAutomation = process.env.DOLPHIN_AUTOMATION !== '0';
const backgroundEnabled = process.env.CREATOR_FLOW_BACKGROUND !== '0';
const dolphinClient = createDolphinClient({ baseUrl: apiBase, token, automation: dolphinAutomation });
const tasks = [];
const proxies = [];
const videos = [];
const channelTasks = [];
const library = [];
const studioCache = {};
const studioSyncBatches = [];
const automationSessions = {};
const settings = { maxConcurrentTasks: 5 };
const logs = [];
const uploadSessions = new Map();
const manualSessionExpiresAt = new Map();
const automationEndpoints = new Map();
const activeOperations = new Map();
const lockedManualProfiles = new Map();
let schedulerRunning = false;
let studioBatchPumpRunning = false;
const execFileAsync = promisify(execFile);
const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_PATH || (path.basename(ffmpegBin).toLowerCase().startsWith('ffmpeg') ? path.join(path.dirname(ffmpegBin), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
const localDolphinTimeoutMs = Math.min(Math.max(Number(process.env.DOLPHIN_LOCAL_API_TIMEOUT_MS) || 15_000, 1_000), 60_000);
const manualSessionTtlMs = Math.min(Math.max(Number(process.env.MANUAL_SESSION_TTL_MS) || 20 * 60_000, 60_000), 24 * 60 * 60_000);
const statePath = process.env.CREATOR_FLOW_STATE_PATH || path.join(root, '.creator-flow-state.json');
const isolatedState = Boolean(process.env.CREATOR_FLOW_STATE_PATH);
const libraryDir = isolatedState ? path.join(path.dirname(statePath), 'library') : path.join(root, 'data', 'library');
fs.mkdirSync(libraryDir, { recursive: true });
const isLegacySmokeRecord = item => item?.title === 'Smoke test' && item?.profileId === 'test-profile' && item?.videoPath === 'C:/test.mp4' && Number(item?.views) === 301 && item?.status === 'published';
const isLegacySmokeProxy = item => item?.host === '127.0.0.1' && Number(item?.port) === 8080 && item?.type === 'http' && item?.username === '' && item?.password === '' && item?.status === 'unverified' && Number(item?.sourceLine) === 1;
let stateNeedsCleanup = false;
let stateLoadError = null;
if (fs.existsSync(statePath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    tasks.push(...(saved.tasks || []));
    const persistedProxies = saved.proxies || [];
    const realProxies = persistedProxies.filter(proxy => !isLegacySmokeProxy(proxy));
    proxies.push(...realProxies);
    const persistedVideos = saved.videos || [];
    const realVideos = persistedVideos.filter(video => !isLegacySmokeRecord(video));
    videos.push(...realVideos);
    channelTasks.push(...(saved.channelTasks || []));
    library.push(...(saved.library || []));
    Object.assign(studioCache, saved.studioCache || {});
    studioSyncBatches.push(...(saved.studioSyncBatches || []));
    Object.assign(automationSessions, saved.automationSessions || {});
    if (saved.settings && Number.isFinite(Number(saved.settings.maxConcurrentTasks))) {
      settings.maxConcurrentTasks = Math.min(Math.max(Math.round(Number(saved.settings.maxConcurrentTasks)), 1), 20);
    }
    stateNeedsCleanup = realVideos.length !== persistedVideos.length || realProxies.length !== persistedProxies.length;
  } catch (error) {
    stateLoadError = error;
    const backupPath = `${statePath}.corrupt-${Date.now()}.bak`;
    try { fs.copyFileSync(statePath, backupPath); } catch {}
  }
}
for (const task of tasks) {
  if (task.manualSessionOpen) {
    task.manualSessionOpen = false;
    task.status = 'profile-ready';
    task.message = 'Локальная сессия ручного входа была закрыта после перезапуска. Откройте вход ещё раз перед продолжением.';
    task.updatedAt = new Date().toISOString();
    stateNeedsCleanup = true;
  } else if (['uploading', 'starting-profile'].includes(task.status)) {
    task.status = 'recovery-needed';
    task.message = 'Работа была прервана перезапуском. Проверьте результат в YouTube Studio, прежде чем создавать новую задачу.';
    task.updatedAt = new Date().toISOString();
    stateNeedsCleanup = true;
  }
}
for (const batch of studioSyncBatches) {
  for (const item of batch.items || []) {
    if (item.status === 'running') {
      item.status = 'queued';
      item.message = 'Синхронизация будет продолжена после перезапуска локальной панели.';
      item.updatedAt = new Date().toISOString();
      stateNeedsCleanup = true;
    }
  }
}
function saveState() {
  if (stateLoadError) {
    throw new Error('Локальное состояние не прочитано; исходный файл сохранён как резервная копия. Восстановите его перед изменением данных.');
  }
  const payload = JSON.stringify({ tasks, proxies, videos, channelTasks, library, studioCache, studioSyncBatches, automationSessions, settings }, null, 2);
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, payload);
    fs.renameSync(tempPath, statePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}
if (stateNeedsCleanup) saveState();
function addLog(message, taskId = null, level = 'info') { logs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), taskId, level, message }); if (logs.length > 500) logs.pop(); }
function getAutomationEndpoint(result) {
  const payload = result?.data || result || {};
  const automation = payload.automation || {};
  const candidate = payload.wsEndpoint || automation.wsEndpoint || payload.remoteDebuggingAddress || payload.remote_debugging_address || payload.debuggerAddress || payload.debugger_address;
  if (candidate && String(candidate).startsWith('/devtools/') && automation.port) return `ws://127.0.0.1:${automation.port}${candidate}`;
  if (candidate) return /^(?:wss?|https?):\/\//i.test(String(candidate)) ? String(candidate) : `http://${candidate}`;
  if (automation.port) return `http://127.0.0.1:${automation.port}`;
  if (payload.selenium_port) return `http://127.0.0.1:${payload.selenium_port}`;
  return null;
}
function publicProfile(profile) {
  return {
    id: profile?.id ?? profile?.uuid ?? '',
    name: profile?.name ?? profile?.title ?? '',
    platform: profile?.platform ?? profile?.platformName ?? '',
    browserType: profile?.browserType ?? '',
    folder: typeof profile?.folder === 'string' ? profile.folder : profile?.folder?.name ?? '',
    tags: Array.isArray(profile?.tags) ? profile.tags.map(tag => typeof tag === 'string' ? tag : tag?.name).filter(Boolean) : [],
    lastStartTime: profile?.lastStartTime ?? null,
  };
}
function publicTask(task) {
  const { wsEndpoint, profileResult, ...safe } = task;
  return safe;
}
function sessionEndpoint(value) {
  return typeof value === 'string' ? value : value?.wsEndpoint;
}
function isLocalAutomationEndpoint(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}
function cacheAutomationEndpoint(profileId, endpoint) {
  if (!endpoint || !isLocalAutomationEndpoint(endpoint)) return false;
  const id = String(profileId);
  automationEndpoints.set(id, endpoint);
  automationSessions[id] = { wsEndpoint: endpoint, updatedAt: new Date().toISOString() };
  return true;
}
function forgetAutomationEndpoint(profileId) {
  const id = String(profileId);
  automationEndpoints.delete(id);
  delete automationSessions[id];
}
function debuggerVersionUrl(endpoint) {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/json/version';
  url.search = '';
  url.hash = '';
  return url;
}
async function automationEndpointAvailable(endpoint) {
  if (!isLocalAutomationEndpoint(endpoint)) return false;
  try {
    const response = await fetch(debuggerVersionUrl(endpoint), { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}
async function discoverRunningProfileEndpoint(profileId) {
  if (process.platform !== 'win32') return null;
  const script = [
    "$id = $env:CREATOR_FLOW_PROFILE_ID;",
    "Get-CimInstance Win32_Process -Filter \"Name = 'anty.exe'\" |",
    "Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match [regex]::Escape($id) } |",
    "ForEach-Object { $match = [regex]::Match($_.CommandLine, '--down-port=(\\d+)'); if ($match.Success) { $match.Groups[1].Value } } |",
    'Select-Object -First 1',
  ].join(' ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      windowsHide: true,
      env: { ...process.env, CREATOR_FLOW_PROFILE_ID: String(profileId) },
      timeout: 5_000,
    });
    const downPort = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
    if (!Number.isInteger(downPort) || downPort < 1 || downPort > 65533) return null;
    for (const offset of [2, 1, 0]) {
      const endpoint = `http://127.0.0.1:${downPort + offset}`;
      if (await automationEndpointAvailable(endpoint)) return endpoint;
    }
  } catch {
    // The profile may be closed or Windows may not allow reading its process metadata.
  }
  return null;
}
for (const [profileId, record] of Object.entries(automationSessions)) {
  const endpoint = sessionEndpoint(record);
  if (isLocalAutomationEndpoint(endpoint)) automationEndpoints.set(profileId, endpoint);
}
async function localDolphin(action, id, automation = false) {
  const query = automation ? '?automation=1' : '';
  const response = await fetch(`${localApi}/v1.0/browser_profiles/${encodeURIComponent(id)}/${action}${query}`, {
    signal: AbortSignal.timeout(localDolphinTimeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.error || `Локальный Dolphin API: ${response.status}`);
  return data;
}
async function startDolphinForAutomation(profileId, restart = false) {
  const cached = automationEndpoints.get(String(profileId));
  if (cached && await automationEndpointAvailable(cached)) return { cached: true, wsEndpoint: cached };
  if (cached) {
    forgetAutomationEndpoint(profileId);
    saveState();
  }
  const discovered = await discoverRunningProfileEndpoint(profileId);
  if (discovered) {
    cacheAutomationEndpoint(profileId, discovered);
    saveState();
    return { attached: true, wsEndpoint: discovered };
  }
  try {
    const result = await localDolphin('start', profileId, dolphinAutomation);
    const wsEndpoint = getAutomationEndpoint(result);
    if (wsEndpoint && cacheAutomationEndpoint(profileId, wsEndpoint)) saveState();
    return result;
  } catch (error) {
    const remembered = automationEndpoints.get(String(profileId));
    if (/already running/i.test(error.message) && remembered && await automationEndpointAvailable(remembered)) {
      return { cached: true, wsEndpoint: remembered };
    }
    if (/already running/i.test(error.message)) {
      const attached = await discoverRunningProfileEndpoint(profileId);
      if (attached) {
        cacheAutomationEndpoint(profileId, attached);
        saveState();
        return { attached: true, wsEndpoint: attached };
      }
    }
    if (!restart || !/already running/i.test(error.message)) throw error;
    await localDolphin('stop', profileId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const result = await localDolphin('start', profileId, dolphinAutomation);
        const wsEndpoint = getAutomationEndpoint(result);
        if (wsEndpoint && cacheAutomationEndpoint(profileId, wsEndpoint)) saveState();
        return result;
      } catch (startError) { if (attempt === 4) throw startError; }
    }
  }
}
function parseStudioViews(value) {
  const text = String(value || '').toLowerCase().replace(/\s/g, '').replace(',', '.');
  const match = text.match(/([\d.]+)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (/тыс\.?|k\b/.test(text)) return Math.round(amount * 1000);
  if (/млн\.?|m\b/.test(text)) return Math.round(amount * 1000000);
  return Math.round(amount);
}
function makeLibraryEntry(metadata, source = 'imported') {
  return { id: crypto.randomUUID(), source, ...metadata, createdAt: new Date().toISOString() };
}
function safeFileName(value) {
  const base = path.basename(String(value || 'video.mp4'));
  const normalized = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '');
  return normalized || 'video.mp4';
}
function workerState() {
  const occupiedProfiles = workerOccupiedProfiles();
  return {
    active: occupiedProfiles.size,
    runningOperations: activeOperations.size,
    limit: settings.maxConcurrentTasks,
    lockedProfiles: lockedManualProfiles.size,
  };
}
function profileOperationKey(profileId) {
  return String(profileId);
}
function workerOccupiedProfiles() {
  return new Set([
    ...lockedManualProfiles.keys(),
    ...[...activeOperations.values()].map(operation => operation.profileKey),
  ]);
}
function activeOperationForProfile(profileId) {
  const profileKey = profileOperationKey(profileId);
  return [...activeOperations.values()].find(operation => operation.profileKey === profileKey) || null;
}
function activeOperationForTask(taskId) {
  const id = String(taskId);
  return [...activeOperations.values()].find(operation => [
    `upload:${id}`,
    `login:${id}`,
    `continue:${id}`,
  ].includes(operation.key)) || null;
}
function touchManualSession(taskId) {
  manualSessionExpiresAt.set(String(taskId), Date.now() + manualSessionTtlMs);
}
async function releaseManualSession(task, { disconnect = true } = {}) {
  if (!task) return;
  const taskId = String(task.id);
  const session = uploadSessions.get(taskId);
  if (disconnect && session) await session.disconnect().catch(() => {});
  uploadSessions.delete(taskId);
  manualSessionExpiresAt.delete(taskId);
  if (lockedManualProfiles.get(profileOperationKey(task.profileId)) === taskId) {
    lockedManualProfiles.delete(profileOperationKey(task.profileId));
  }
  delete task.manualSessionOpen;
}
async function expireManualSessions() {
  const now = Date.now();
  let changed = false;
  for (const [taskId, expiresAt] of manualSessionExpiresAt) {
    if (expiresAt > now) continue;
    const task = tasks.find(item => String(item.id) === taskId);
    if (!task || activeOperationForProfile(task.profileId)) continue;
    await releaseManualSession(task);
    task.status = 'profile-ready';
    task.message = 'Сессия ручного входа закрыта по тайм-ауту. При необходимости откройте вход снова.';
    task.updatedAt = new Date().toISOString();
    addLog('Сессия ручного входа закрыта по тайм-ауту', task.id, 'warn');
    changed = true;
  }
  if (changed) saveState();
}
function queueProfileOperation({ key, profileId, work, allowManualSessionTaskId = null }) {
  if (activeOperations.has(key)) {
    return { started: false, code: 'operation-already-running', message: 'Эта задача уже выполняется.' };
  }
  const profileKey = profileOperationKey(profileId);
  const manualTaskId = lockedManualProfiles.get(profileKey);
  const permittedManualSession = manualTaskId && manualTaskId === String(allowManualSessionTaskId || '');
  if (manualTaskId && !permittedManualSession) {
    return { started: false, code: 'profile-manual-session', message: 'Профиль занят открытой сессией ручного входа.' };
  }
  if ([...activeOperations.values()].some(operation => operation.profileKey === profileKey)) {
    return { started: false, code: 'profile-busy', message: 'Для этого профиля уже выполняется другая задача.' };
  }
  if (!permittedManualSession && workerOccupiedProfiles().size >= settings.maxConcurrentTasks) {
    return { started: false, code: 'workers-busy', message: `Все потоки заняты (${settings.maxConcurrentTasks}). Задача останется в очереди.` };
  }

  const operation = { key, profileKey, startedAt: new Date().toISOString(), promise: null };
  activeOperations.set(key, operation);
  operation.promise = (async () => {
    try {
      return await work();
    } finally {
      activeOperations.delete(key);
      if (backgroundEnabled) {
        queueMicrotask(() => {
          processScheduledTasks().catch(error => addLog(`Ошибка планировщика: ${error.message}`, null, 'error'));
          processStudioSyncBatches().catch(error => addLog(`Ошибка очереди пакетной синхронизации: ${error.message}`, null, 'error'));
        });
      }
    }
  })();
  return { started: true, promise: operation.promise };
}
function queueUploadTask(task, { uploadOnly = false } = {}) {
  return queueProfileOperation({
    key: `upload:${task.id}`,
    profileId: task.profileId,
    work: async () => {
      if (!uploadOnly) await startQueuedTask(task);
      if ((uploadOnly || task.autoUpload) && task.status === 'profile-ready') await runTaskUpload(task);
      return task;
    },
  });
}
async function startQueuedTask(task) {
  if (task.status !== 'queued') return task;
  task.status = 'starting-profile'; task.updatedAt = new Date().toISOString(); addLog(`Запуск запланированной задачи для профиля ${task.profileId}`, task.id); saveState();
  try {
    task.profileResult = await startDolphinForAutomation(task.profileId);
    task.wsEndpoint = getAutomationEndpoint(task.profileResult);
    task.status = task.wsEndpoint ? 'profile-ready' : 'manual-login-required';
    task.message = task.wsEndpoint ? 'Профиль запущен. Готов к браузерному этапу публикации.' : 'Профиль запущен. Выполните ручной вход; для браузерного этапа нужен тариф Dolphin с Automation API.';
    addLog(`Профиль запущен${task.wsEndpoint ? ', адрес браузера получен' : ', адрес браузера не найден в ответе API'}`, task.id, task.wsEndpoint ? 'info' : 'warn');
  } catch (error) { task.status = 'error'; task.error = error.message; addLog(`Ошибка запуска профиля: ${error.message}`, task.id, 'error'); }
  task.updatedAt = new Date().toISOString(); saveState(); return task;
}
async function processScheduledTasks() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    const dueTasks = tasks
      .filter(task => task.status === 'queued' && task.autoUpload && (!task.scheduledAt || Date.parse(task.scheduledAt) <= now))
      .sort((left, right) => (Date.parse(left.scheduledAt || 0) || 0) - (Date.parse(right.scheduledAt || 0) || 0));
    for (const task of dueTasks) {
      if (workerOccupiedProfiles().size >= settings.maxConcurrentTasks) break;
      const operation = queueUploadTask(task);
      if (operation.started) operation.promise.catch(error => addLog(`Ошибка фоновой задачи: ${error.message}`, task.id, 'error'));
    }
  } finally {
    schedulerRunning = false;
  }
}
async function runTaskUpload(task) {
  const wsEndpoint = task.wsEndpoint
    || automationEndpoints.get(String(task.profileId))
    || getAutomationEndpoint(task.profileResult);
  if (!wsEndpoint) throw new Error('Профиль Dolphin не выдал адрес автоматизации. Запустите профиль с Automation API.');
  if (!fs.existsSync(task.videoPath)) throw new Error('Файл ролика не найден по указанному пути.');
  task.status = 'uploading';
  task.updatedAt = new Date().toISOString();
  addLog('Начата загрузка ролика в браузере профиля', task.id);
  saveState();
  try {
    task.uploadResult = await uploadOwnVideo({ wsEndpoint, videoPath: task.videoPath, title: task.title, description: task.description, tags: task.tags });
    task.status = task.uploadResult.status === 'manual-login-required' ? 'manual-login-required' : 'awaiting-review';
    task.message = task.status === 'awaiting-review' ? 'Файл загружен в форму YouTube Studio и ожидает проверки перед публикацией.' : 'Откройте профиль Dolphin и выполните ручной вход в YouTube.';
    addLog(task.message, task.id, task.status === 'awaiting-review' ? 'info' : 'warn');
  } catch (error) {
    task.status = 'error'; task.error = error.message;
    addLog(`Ошибка загрузки: ${error.message}`, task.id, 'error');
  }
  task.updatedAt = new Date().toISOString();
  saveState();
  return task;
}
const scheduler = setInterval(() => {
  if (!backgroundEnabled) return;
  processScheduledTasks().catch(error => addLog(`Ошибка планировщика: ${error.message}`, null, 'error'));
  processStudioSyncBatches().catch(error => addLog(`Ошибка очереди пакетной синхронизации: ${error.message}`, null, 'error'));
}, 5000);
scheduler.unref();
const manualSessionJanitor = setInterval(() => { expireManualSessions().catch(error => addLog(`Ошибка очистки ручных сессий: ${error.message}`, null, 'error')); }, 60_000);
manualSessionJanitor.unref();

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
    const localAuthorized = response.status >= 200 && response.status < 400;
    res.json({
      configured: Boolean(token),
      remoteApi,
      localApi,
      localReachable: true,
      localAuthorized,
      localStatus: response.status,
    });
  } catch {
    res.json({ configured: Boolean(token), remoteApi, localApi, localReachable: false, localAuthorized: false });
  }
});

app.get('/api/profiles', async (_req, res) => {
  try {
    const result = await dolphinClient.listProfiles();
    const rows = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
    res.json({ data: rows.map(publicProfile), total: Number(result?.total ?? result?.meta?.total ?? rows.length) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/start', async (req, res) => {
  const operation = queueProfileOperation({
    key: `profile-start:${req.params.id}`,
    profileId: req.params.id,
    work: () => startDolphinForAutomation(req.params.id),
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    const result = await operation.promise;
    res.json({ profileId: req.params.id, started: true, automationAvailable: Boolean(getAutomationEndpoint(result)) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/:id/stop', async (req, res) => {
  const operation = queueProfileOperation({
    key: `profile-stop:${req.params.id}`,
    profileId: req.params.id,
    work: async () => {
      await localDolphin('stop', req.params.id);
      forgetAutomationEndpoint(req.params.id);
      saveState();
      return { profileId: req.params.id, stopped: true };
    },
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    res.json(await operation.promise);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

async function readProfileChannel(profileId, restart = false) {
  const profileResult = await startDolphinForAutomation(profileId, restart);
  const wsEndpoint = getAutomationEndpoint(profileResult);
  const channel = wsEndpoint ? await inspectChannel({ wsEndpoint }) : { status: 'automation-unavailable' };
  addLog(`Проверка YouTube-профиля ${profileId}: ${channel.status}`);
  return { profileId, channel };
}

async function syncProfileVideos(profileId, { restart = false, limit = 100 } = {}) {
  const profileResult = await startDolphinForAutomation(profileId, restart);
  const wsEndpoint = getAutomationEndpoint(profileResult);
  if (!wsEndpoint) throw new Error('Dolphin не выдал адрес Automation API для этого профиля.');
  const result = await readStudioVideos({ wsEndpoint, limit });
  if (result.status === 'manual-login-required') return { profileId, ...result };
  const normalized = result.videos.map(video => ({ ...video, viewsNumber: parseStudioViews(video.views) }));
  studioCache[profileId] = { profileId, syncedAt: new Date().toISOString(), url: result.url, videos: normalized };
  saveState();
  addLog(`Синхронизирован список роликов YouTube Studio: ${normalized.length}`, null, 'info');
  return { profileId, status: 'synced', syncedAt: studioCache[profileId].syncedAt, videos: normalized, total: normalized.length, url: result.url };
}

function summarizeStudioBatch(batch) {
  const items = Array.isArray(batch?.items) ? batch.items : [];
  const counts = items.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    total: items.length,
    queued: counts.queued || 0,
    running: counts.running || 0,
    completed: counts.completed || 0,
    failed: counts.error || 0,
    manualLoginRequired: counts['manual-login-required'] || 0,
  };
}

function refreshStudioBatchStatus(batch) {
  const summary = summarizeStudioBatch(batch);
  const status = summary.queued || summary.running
    ? 'running'
    : summary.manualLoginRequired
      ? 'needs-login'
      : summary.failed
        ? 'completed-with-errors'
        : 'completed';
  if (batch.status !== status) {
    batch.status = status;
    batch.updatedAt = new Date().toISOString();
  }
  return summary;
}

function publicStudioBatch(batch) {
  const summary = summarizeStudioBatch(batch);
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    status: batch.status,
    limit: batch.limit,
    ...summary,
    items: (batch.items || []).map(item => ({
      profileId: item.profileId,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      syncedAt: item.syncedAt || null,
      total: Number(item.total || 0),
      error: item.error || '',
      message: item.message || '',
    })),
  };
}

async function runStudioBatchItem(batch, item) {
  item.status = 'running';
  item.error = '';
  item.message = 'Считываем список роликов из YouTube Studio.';
  item.updatedAt = new Date().toISOString();
  refreshStudioBatchStatus(batch);
  saveState();
  try {
    const result = await syncProfileVideos(item.profileId, { limit: batch.limit });
    if (result.status === 'manual-login-required') {
      item.status = 'manual-login-required';
      item.message = 'В этом профиле нужно завершить ручной вход в YouTube.';
    } else {
      item.status = 'completed';
      item.total = result.total;
      item.syncedAt = result.syncedAt;
      item.message = `Считано роликов: ${result.total}.`;
    }
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
    item.message = 'Синхронизация не выполнена.';
    addLog(`Ошибка пакетной синхронизации профиля ${item.profileId}: ${error.message}`, null, 'error');
  }
  item.updatedAt = new Date().toISOString();
  refreshStudioBatchStatus(batch);
  saveState();
}

async function processStudioSyncBatches() {
  if (studioBatchPumpRunning) return;
  studioBatchPumpRunning = true;
  try {
    let changed = false;
    for (const batch of studioSyncBatches) {
      if (!['queued', 'running'].includes(batch.status)) continue;
      for (const item of batch.items || []) {
        if (item.status !== 'queued') continue;
        if (workerOccupiedProfiles().size >= settings.maxConcurrentTasks) return;
        const operation = queueProfileOperation({
          key: `studio-batch:${batch.id}:${item.profileId}`,
          profileId: item.profileId,
          work: () => runStudioBatchItem(batch, item),
        });
        if (operation.started) {
          operation.promise
            .catch(error => addLog(`Ошибка фоновой пакетной синхронизации: ${error.message}`, null, 'error'))
            .finally(() => {
              if (backgroundEnabled) processStudioSyncBatches().catch(error => addLog(`Ошибка очереди пакетной синхронизации: ${error.message}`, null, 'error'));
            });
        } else if (operation.code === 'workers-busy') {
          return;
        }
      }
      const before = batch.status;
      refreshStudioBatchStatus(batch);
      changed = changed || batch.status !== before;
    }
    if (changed) saveState();
  } finally {
    studioBatchPumpRunning = false;
  }
}

app.post('/api/profiles/:id/youtube-status', async (req, res) => {
  const operation = queueProfileOperation({
    key: `inspect:${req.params.id}`,
    profileId: req.params.id,
    work: () => readProfileChannel(req.params.id, req.body?.restart === true),
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    res.json(await operation.promise);
  } catch (error) {
    if (/already running/i.test(error.message)) return res.status(409).json({ error: 'Профиль уже запущен вне Creator Flow. Для чтения данных нажмите «Перезапустить и считать».', code: 'profile-already-running' });
    res.status(422).json({ error: error.message });
  }
});

app.post('/api/profiles/:id/videos/sync', async (req, res) => {
  const operation = queueProfileOperation({
    key: `sync:${req.params.id}`,
    profileId: req.params.id,
    work: () => syncProfileVideos(req.params.id, { restart: req.body?.restart === true, limit: req.body?.limit || 100 }),
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    res.json(await operation.promise);
  } catch (error) {
    if (/already running/i.test(error.message)) return res.status(409).json({ error: 'Профиль уже запущен вне Creator Flow. Нажмите «Перезапустить и синхронизировать».', code: 'profile-already-running' });
    res.status(422).json({ error: error.message });
  }
});

app.get('/api/tasks', (_req, res) => res.json({ tasks: tasks.map(publicTask) }));
app.get('/api/logs', (_req, res) => res.json({ logs: logs.slice(0, 200) }));
app.get('/api/videos', (_req, res) => res.json({ videos }));
app.get('/api/library', (_req, res) => res.json({ library }));
app.get('/api/settings', (_req, res) => res.json({ settings: { ...settings }, worker: workerState() }));
app.patch('/api/settings', (req, res) => {
  if (req.body?.maxConcurrentTasks !== undefined) {
    const requested = Number(req.body.maxConcurrentTasks);
    if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
      return res.status(400).json({ error: 'Количество потоков должно быть целым числом от 1 до 20.' });
    }
    settings.maxConcurrentTasks = requested;
    saveState();
    if (backgroundEnabled) {
      processScheduledTasks().catch(error => addLog(`Ошибка планировщика: ${error.message}`, null, 'error'));
      processStudioSyncBatches().catch(error => addLog(`Ошибка очереди пакетной синхронизации: ${error.message}`, null, 'error'));
    }
  }
  res.json({ settings: { ...settings }, worker: workerState() });
});
app.get('/api/studio-videos', (req, res) => {
  const profileId = String(req.query.profileId || '');
  const record = studioCache[profileId];
  res.json(record || { profileId, syncedAt: null, videos: [], total: 0 });
});
app.get('/api/studio/sync-batches', (_req, res) => {
  res.json({ batches: studioSyncBatches.slice(0, 20).map(publicStudioBatch) });
});
app.post('/api/studio/sync-batches', (req, res) => {
  const rawIds = Array.isArray(req.body?.profileIds) ? req.body.profileIds : [];
  const profileIds = [...new Set(rawIds.map(value => String(value || '').trim()).filter(Boolean))];
  if (!profileIds.length) return res.status(400).json({ error: 'Выберите хотя бы один профиль Dolphin.' });
  if (profileIds.length > 100) return res.status(400).json({ error: 'За один пакет можно добавить не более 100 профилей.' });
  const requestedLimit = Number(req.body?.limit || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
  const now = new Date().toISOString();
  const batch = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    limit,
    items: profileIds.map(profileId => ({ profileId, status: 'queued', createdAt: now, updatedAt: now })),
  };
  studioSyncBatches.unshift(batch);
  if (studioSyncBatches.length > 20) studioSyncBatches.splice(20);
  refreshStudioBatchStatus(batch);
  saveState();
  if (backgroundEnabled) processStudioSyncBatches().catch(error => addLog(`Ошибка запуска пакетной синхронизации: ${error.message}`, null, 'error'));
  res.status(202).json({ batch: publicStudioBatch(batch), worker: workerState() });
});
app.get('/api/channels/tasks', (_req, res) => res.json({ tasks: channelTasks }));
app.get('/api/videos/stats', (_req, res) => {
  const stats = videos.reduce((acc, video) => ({ count: acc.count + 1, views: acc.views + Number(video.views || 0), likes: acc.likes + Number(video.likes || 0), comments: acc.comments + Number(video.comments || 0), zeroViews: acc.zeroViews + (Number(video.views || 0) === 0 ? 1 : 0), over300: acc.over300 + (Number(video.views || 0) >= 300 ? 1 : 0), unavailable: acc.unavailable + (video.status === 'unavailable' ? 1 : 0) }), { count: 0, views: 0, likes: 0, comments: 0, zeroViews: 0, over300: 0, unavailable: 0 });
  res.json(stats);
});
app.post('/api/videos', (req, res) => {
  const { title, videoPath, profileId, publishedAt = null, views = 0, likes = 0, comments = 0, origin = 'manual' } = req.body || {};
  if (origin === 'smoke-test' && !isolatedState) return res.status(403).json({ error: 'Тестовые записи разрешены только в изолированном состоянии.' });
  if (!title || !videoPath || !profileId) return res.status(400).json({ error: 'title, videoPath и profileId обязательны' });
  const video = { id: crypto.randomUUID(), title, videoPath, profileId, publishedAt, views: Number(views), likes: Number(likes), comments: Number(comments), origin, status: 'published', createdAt: new Date().toISOString() };
  videos.push(video); saveState(); addLog(`Видео добавлено в реестр: ${title}`); res.status(201).json(video);
});
app.patch('/api/videos/:id/stats', (req, res) => {
  const video = videos.find(item => item.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  for (const key of ['views', 'likes', 'comments']) if (req.body?.[key] !== undefined) video[key] = Math.max(0, Number(req.body[key]) || 0);
  if (req.body?.status) video.status = String(req.body.status);
  video.updatedAt = new Date().toISOString(); saveState(); res.json(video);
});

app.post('/api/library/import', async (req, res) => {
  const filePath = String(req.body?.filePath || '').trim();
  try {
    const metadata = await inspectMediaFile(filePath, { ffprobeBin });
    const existing = library.find(item => path.resolve(item.filePath) === path.resolve(metadata.filePath));
    if (existing) return res.json({ item: existing, existing: true });
    const item = makeLibraryEntry(metadata, 'external-path');
    library.unshift(item); saveState(); addLog(`Добавлен ролик в библиотеку: ${item.fileName}`); res.status(201).json({ item });
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.post('/api/library/upload', express.raw({ type: 'application/octet-stream', limit: '750mb' }), async (req, res) => {
  const originalName = safeFileName(req.query.name || req.headers['x-file-name']);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Файл не получен.' });
  const extension = path.extname(originalName).toLowerCase();
  if (!['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'].includes(extension)) return res.status(415).json({ error: 'Поддерживаются видеофайлы MP4, MOV, MKV, WebM, AVI и M4V.' });
  const targetPath = path.join(libraryDir, `${crypto.randomUUID()}-${originalName}`);
  try {
    fs.writeFileSync(targetPath, req.body);
    const metadata = await inspectMediaFile(targetPath, { ffprobeBin });
    const item = makeLibraryEntry(metadata, 'uploaded');
    library.unshift(item); saveState(); addLog(`Файл скопирован в библиотеку: ${item.fileName}`); res.status(201).json({ item });
  } catch (error) {
    fs.rmSync(targetPath, { force: true });
    res.status(422).json({ error: error.message });
  }
});

app.delete('/api/library/:id', (req, res) => {
  const index = library.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Файл не найден в библиотеке.' });
  const [item] = library.splice(index, 1);
  saveState(); addLog(`Файл убран из списка библиотеки: ${item.fileName}`); res.json({ removed: item, fileRetained: true });
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
  if (task.manualSessionOpen) return res.status(409).json({ error: 'Для открытой ручной сессии используйте «Проверить вход».', code: 'manual-session-open', worker: workerState() });
  const operation = queueUploadTask(task);
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(publicTask(task));
});

app.post('/api/tasks/:id/upload', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (task.manualSessionOpen) return res.status(409).json({ error: 'Для открытой ручной сессии используйте «Проверить вход».', code: 'manual-session-open', worker: workerState() });
  const operation = queueUploadTask(task, { uploadOnly: true });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(publicTask(task));
});

app.post('/api/tasks/:id/prepare-login', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  const operation = queueProfileOperation({
    key: `login:${task.id}`,
    profileId: task.profileId,
    work: async () => {
      if (!task.wsEndpoint && !getAutomationEndpoint(task.profileResult)) await startQueuedTask(task);
      const wsEndpoint = task.wsEndpoint || automationEndpoints.get(String(task.profileId)) || getAutomationEndpoint(task.profileResult);
      const session = await openUploadSession({ wsEndpoint });
      uploadSessions.set(task.id, session);
      touchManualSession(task.id);
      lockedManualProfiles.set(profileOperationKey(task.profileId), task.id);
      task.manualSessionOpen = true;
      task.status = session.needsLogin ? 'manual-login-required' : 'login-ready';
      task.updatedAt = new Date().toISOString();
      addLog(session.needsLogin ? 'Открыт YouTube: требуется ручной вход' : 'Профиль уже авторизован в YouTube', task.id, session.needsLogin ? 'warn' : 'info');
      saveState();
      return session;
    },
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    const session = await operation.promise;
    res.json({ task: publicTask(task), needsLogin: session.needsLogin });
  } catch (error) {
    task.status = 'error'; task.error = error.message; addLog(`Ошибка открытия YouTube: ${error.message}`, task.id, 'error'); saveState();
    res.status(422).json(publicTask(task));
  }
});

async function continueManualTaskUpload(task) {
  const session = uploadSessions.get(task.id);
  if (!session) throw new Error('Сессия ручного входа не найдена');
  touchManualSession(task.id);
  task.manualSessionOpen = true;
  task.status = 'uploading';
  task.updatedAt = new Date().toISOString();
  task.error = undefined;
  task.message = 'Проверяем вход и загружаем ролик в форму YouTube Studio.';
  addLog('Продолжена загрузка после ручного входа', task.id);
  saveState();
  try {
    const result = await uploadIntoSession({ session, videoPath: task.videoPath, title: task.title, description: task.description, tags: task.tags });
    if (result.status === 'manual-login-required') {
      task.status = 'manual-login-required';
      task.message = 'Вход в YouTube ещё не завершён. Завершите его в открытом профиле и нажмите «Проверить вход». ';
      task.updatedAt = new Date().toISOString();
      touchManualSession(task.id);
      saveState();
      return { needsLogin: true, result };
    }
    await releaseManualSession(task);
    task.uploadResult = result;
    task.status = 'awaiting-review';
    task.message = 'Файл загружен в форму YouTube Studio и ожидает проверки перед публикацией.';
    task.updatedAt = new Date().toISOString();
    addLog('Ручной вход подтверждён, видео загружено в форму', task.id);
    saveState();
    return { needsLogin: false, result };
  } catch (error) {
    await releaseManualSession(task);
    task.status = 'error';
    task.error = error.message;
    task.updatedAt = new Date().toISOString();
    addLog(`Ошибка продолжения загрузки: ${error.message}`, task.id, 'error');
    saveState();
    throw error;
  }
}

app.post('/api/tasks/:id/upload/continue', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task || !uploadSessions.has(task.id)) return res.status(404).json({ error: 'Сессия ручного входа не найдена' });
  const operation = queueProfileOperation({
    key: `continue:${task.id}`,
    profileId: task.profileId,
    allowManualSessionTaskId: task.id,
    work: () => continueManualTaskUpload(task),
  });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  try {
    const outcome = await operation.promise;
    if (outcome.needsLogin) return res.status(409).json({ error: 'Вход ещё не выполнен', task: publicTask(task) });
    res.json(publicTask(task));
  } catch {
    res.status(422).json(publicTask(task));
  }
});

app.post('/api/tasks', (req, res) => {
  const { profileId, videoPath, title, description = '', tags = [], scheduledAt = null, autoUpload = true } = req.body || {};
  if (!profileId || !videoPath || !title) return res.status(400).json({ error: 'profileId, videoPath и title обязательны' });
  const task = { id: crypto.randomUUID(), profileId, videoPath, title, description, tags: Array.isArray(tags) ? tags : [], scheduledAt, autoUpload: Boolean(autoUpload), status: 'queued', createdAt: new Date().toISOString() };
  tasks.push(task);
  saveState();
  if (backgroundEnabled && task.autoUpload) queueMicrotask(() => processScheduledTasks().catch(error => addLog(`Ошибка автоматического запуска: ${error.message}`, task.id, 'error')));
  res.status(201).json(publicTask(task));
});

app.post('/api/tasks/:id/cancel', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (activeOperationForTask(task.id)) {
    return res.status(409).json({ error: 'Задача сейчас выполняется. Дождитесь завершения операции, затем отмените её.', code: 'task-busy', worker: workerState() });
  }
  await releaseManualSession(task);
  task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
  saveState();
  res.json(publicTask(task));
});

app.post('/api/channels/tasks', (req, res) => {
  const { profileId, name = '', description = '', links = [], avatarPath = '', bannerPath = '' } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId обязателен' });
  const safeLinks = Array.isArray(links) ? links.filter(link => link && typeof link.title === 'string' && typeof link.url === 'string') : [];
  if (!name && !description && !safeLinks.length && !avatarPath && !bannerPath) return res.status(400).json({ error: 'Укажите хотя бы одно изменение оформления канала' });
  const task = { id: crypto.randomUUID(), profileId, name, description, links: safeLinks, avatarPath, bannerPath, status: 'queued', createdAt: new Date().toISOString() };
  channelTasks.unshift(task); saveState(); addLog(`Задача оформления канала создана для профиля ${profileId}`, task.id); res.status(201).json(task);
});

async function runChannelTask(task) {
  task.status = 'starting-profile'; task.updatedAt = new Date().toISOString(); saveState();
  try {
    const profileResult = await startDolphinForAutomation(task.profileId);
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
  task.updatedAt = new Date().toISOString(); saveState(); return task;
}
function queueChannelTask(task) {
  return queueProfileOperation({
    key: `channel:${task.id}`,
    profileId: task.profileId,
    work: () => runChannelTask(task),
  });
}

app.post('/api/channels/tasks/:id/run', async (req, res) => {
  const task = channelTasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача оформления канала не найдена' });
  const operation = queueChannelTask(task);
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(task);
});

app.get('/api/uniqueizer/health', async (_req, res) => {
  try { const result = await execFileAsync(ffmpegBin, ['-version']); res.json({ available: true, path: ffmpegBin, version: result.stdout.split('\n')[0] }); }
  catch { res.json({ available: false, message: 'FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.' }); }
});

app.post('/api/uniqueizer/render', async (req, res) => {
  const { inputPath, outputPath, overlayPath } = req.body || {};
  if (!inputPath || !outputPath) return res.status(400).json({ error: 'inputPath и outputPath обязательны' });
  try { await inspectMediaFile(inputPath, { ffprobeBin }); }
  catch (error) { return res.status(422).json({ status: 'error', error: error.message }); }
  const args = ['-y', '-i', inputPath];
  if (overlayPath) args.push('-i', overlayPath, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto');
  args.push('-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', outputPath);
  try {
    await execFileAsync(ffmpegBin, args, { windowsHide: true });
    const metadata = await inspectMediaFile(outputPath, { ffprobeBin });
    const existing = library.find(item => path.resolve(item.filePath) === path.resolve(metadata.filePath));
    const item = existing || makeLibraryEntry(metadata, 'processed');
    if (!existing) library.unshift(item);
    saveState(); addLog(`Обработка завершена: ${metadata.fileName}`);
    res.status(201).json({ status: 'completed', outputPath, item });
  }
  catch (error) { res.status(422).json({ status: 'error', error: error.message, hint: 'Установите FFmpeg и проверьте пути к файлам.' }); }
});

const server = app.listen(Number(process.env.PORT || 3030), () => console.log(`Creator Flow: http://localhost:${process.env.PORT || 3030}`));
export { app, server };
