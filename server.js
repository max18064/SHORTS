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
import {
  MAX_EDITORIAL_CAMPAIGN_OUTPUTS,
  buildFfmpegArgs,
  createEditorialRecipe,
  listEditorialPresets,
  resolveEditorialPreset,
  validateEditorialRecipe,
} from './variant-recipes.js';

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
// A processing batch is intentionally separate from upload and Dolphin work.
// It contains only explicit local input/output pairs for media the operator
// has already placed in the Creator Flow library.
const processingBatches = [];
// A media campaign joins an explicit, local processing batch to a
// deterministic, review-only upload plan.  It never contains credentials and
// it never starts a Dolphin/YouTube operation merely by being created.
const mediaCampaigns = [];
const studioCache = {};
const studioSyncBatches = [];
// Account status is intentionally a small, read-only cache.  It never keeps
// browser cookies, credentials, avatar URLs, or any of the raw Studio page.
// The profile id is the object key; every persisted value is normalized by
// `sanitizeAccountStatus` below.
const accountStatusCache = Object.create(null);
const accountCheckBatches = [];
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
let accountCheckBatchPumpRunning = false;
let channelTaskPumpRunning = false;
let processingBatchPumpRunning = false;
const activeProcessingJobIds = new Set();
const activeProcessingOutputPaths = new Set();
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
    processingBatches.push(...(Array.isArray(saved.processingBatches) ? saved.processingBatches.filter(isObjectRecord) : []));
    mediaCampaigns.push(...(Array.isArray(saved.mediaCampaigns) ? saved.mediaCampaigns.filter(isObjectRecord) : []));
    Object.assign(studioCache, saved.studioCache || {});
    studioSyncBatches.push(...(saved.studioSyncBatches || []));
    const persistedAccounts = isObjectRecord(saved.accountStatusCache) ? saved.accountStatusCache : {};
    for (const [rawProfileId, rawAccount] of Object.entries(persistedAccounts)) {
      const profileId = String(rawProfileId || '').trim();
      if (!profileId) continue;
      accountStatusCache[profileId] = sanitizeAccountStatus(rawAccount, rawAccount?.checkedAt);
    }
    accountCheckBatches.push(...(Array.isArray(saved.accountCheckBatches) ? saved.accountCheckBatches.filter(isObjectRecord) : []));
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
for (const task of channelTasks) {
  if (!task || typeof task !== 'object') continue;
  if (['starting-profile', 'applying'].includes(task.status)) {
    task.status = 'recovery-needed';
    task.message = 'Оформление канала было прервано перезапуском. Проверьте результат в YouTube Studio и запустите задачу повторно только при необходимости.';
    task.updatedAt = new Date().toISOString();
    stateNeedsCleanup = true;
  }
}
for (const batch of processingBatches) {
  if (!Array.isArray(batch.items)) {
    batch.items = [];
    stateNeedsCleanup = true;
  } else {
    const validItems = batch.items.filter(isObjectRecord);
    if (validItems.length !== batch.items.length) {
      batch.items = validItems;
      stateNeedsCleanup = true;
    }
  }
  for (const item of batch.items) {
    if (item.status === 'running') {
      // A local encoder may have written a partial temporary file when the
      // panel was stopped. Never silently repeat that operation or mark it as
      // complete; it must be retried explicitly after inspecting the output.
      item.status = 'recovery-needed';
      item.message = 'Обработка была прервана перезапуском. Проверьте выходной файл и при необходимости перезапустите только эту задачу.';
      item.updatedAt = new Date().toISOString();
      stateNeedsCleanup = true;
    }
  }
  const previousStatus = batch.status;
  refreshProcessingBatchStatus(batch);
  if (batch.status !== previousStatus) stateNeedsCleanup = true;
}
for (const campaign of mediaCampaigns) {
  if (!Array.isArray(campaign.assignments)) {
    campaign.assignments = [];
    stateNeedsCleanup = true;
  } else {
    const validAssignments = campaign.assignments.filter(isObjectRecord);
    if (validAssignments.length !== campaign.assignments.length) {
      campaign.assignments = validAssignments;
      stateNeedsCleanup = true;
    }
  }
  for (const assignment of campaign.assignments) {
    const batch = processingBatches.find(item => item.id === assignment.processingBatchId);
    const item = batch?.items?.find(candidate => candidate.id === assignment.processingItemId);
    if (item?.status === 'recovery-needed' && ['running', 'processing'].includes(assignment.status)) {
      assignment.status = 'recovery-needed';
      assignment.message = 'Локальная обработка была прервана перезапуском. Проверьте выходной файл и перезапустите только эту кампанию при необходимости.';
      assignment.updatedAt = new Date().toISOString();
      stateNeedsCleanup = true;
    }
  }
  const previousStatus = campaign.status;
  refreshMediaCampaignStatus(campaign);
  if (campaign.status !== previousStatus) stateNeedsCleanup = true;
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
for (const batch of accountCheckBatches) {
  if (!Array.isArray(batch.items)) {
    batch.items = [];
    stateNeedsCleanup = true;
  } else {
    const validItems = batch.items.filter(isObjectRecord);
    if (validItems.length !== batch.items.length) {
      batch.items = validItems;
      stateNeedsCleanup = true;
    }
  }
  for (const item of batch.items || []) {
    if (item.status === 'running') {
      item.status = 'queued';
      item.message = 'Проверка будет продолжена после перезапуска локальной панели.';
      item.updatedAt = new Date().toISOString();
      stateNeedsCleanup = true;
    }
  }
  const previousStatus = batch.status;
  refreshAccountCheckBatchStatus(batch);
  if (batch.status !== previousStatus) stateNeedsCleanup = true;
}
function saveState() {
  if (stateLoadError) {
    throw new Error('Локальное состояние не прочитано; исходный файл сохранён как резервная копия. Восстановите его перед изменением данных.');
  }
  const payload = JSON.stringify({ tasks, proxies, videos, channelTasks, library, processingBatches, mediaCampaigns, studioCache, studioSyncBatches, accountStatusCache, accountCheckBatches, automationSessions, settings }, null, 2);
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
    folderId: profile?.folderId ?? profile?.folder_id ?? profile?.folder?.id ?? null,
    tags: Array.isArray(profile?.tags) ? profile.tags.map(tag => typeof tag === 'string' ? tag : tag?.name).filter(Boolean) : [],
    lastStartTime: profile?.lastStartTime ?? null,
  };
}
function cleanAccountText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function cleanAccountUrl(value) {
  const raw = cleanAccountText(value, 2_000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    // Studio URLs do not need URL fragments, credentials, or query parameters
    // for account identification. Dropping them keeps the cache non-sensitive.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}
function cleanCheckedAt(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}
function sanitizeAccountStatus(channel, checkedAt = new Date().toISOString()) {
  return {
    status: cleanAccountText(channel?.status, 64) || 'unknown',
    channelName: cleanAccountText(channel?.channelName, 200),
    url: cleanAccountUrl(channel?.url),
    checkedAt: cleanCheckedAt(checkedAt),
  };
}
function cacheAccountStatus(profileId, channel) {
  const id = String(profileId || '').trim();
  if (!id) return null;
  const account = sanitizeAccountStatus(channel);
  accountStatusCache[id] = account;
  saveState();
  return account;
}
function publicAccount(profileId, account) {
  return { profileId: String(profileId), ...sanitizeAccountStatus(account, account?.checkedAt) };
}
function publicFolder(folder) {
  const profiles = Array.isArray(folder?.browserProfilesData) ? folder.browserProfilesData : [];
  return {
    id: folder?.id ?? '',
    name: folder?.name ?? '',
    emoji: folder?.emoji ?? '',
    isPinned: Boolean(folder?.isPinned ?? folder?.pinned),
    profileCount: Number(folder?.profileCount ?? folder?.profilesCount ?? profiles.length ?? 0),
  };
}
function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function dolphinEntity(result) {
  return isObjectRecord(result?.data) ? result.data : isObjectRecord(result) ? result : {};
}
function responseRows(result) {
  if (Array.isArray(result?.data)) return result.data;
  return Array.isArray(result) ? result : [];
}
function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
function cleanRequiredString(value, label, maxLength) {
  if (typeof value !== 'string') throw validationError(`${label} обязателен.`);
  const cleaned = value.trim();
  if (!cleaned) throw validationError(`${label} обязателен.`);
  if (cleaned.length > maxLength) throw validationError(`${label} не должен быть длиннее ${maxLength} символов.`);
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw validationError(`${label} содержит недопустимые символы.`);
  return cleaned;
}
function normalizeFolderInput(body) {
  const name = cleanRequiredString(body?.name, 'Название папки', 50);
  let emoji = '';
  if (body?.emoji !== undefined && body?.emoji !== null && body?.emoji !== '') {
    if (typeof body.emoji !== 'string') throw validationError('Значок папки должен быть строкой.');
    emoji = body.emoji.trim();
    if (emoji.length > 32 || /[\u0000-\u001f\u007f]/.test(emoji)) throw validationError('Значок папки содержит недопустимые символы.');
  }
  const isPinnedSource = body?.isPinned ?? body?.pinned ?? false;
  if (typeof isPinnedSource !== 'boolean') throw validationError('Параметр закрепления папки должен быть логическим значением.');
  return { name, ...(emoji ? { emoji } : {}), isPinned: isPinnedSource };
}
function normalizeProfileCreationInput(body) {
  const name = cleanRequiredString(body?.name, 'Название профиля', 255);
  const platform = typeof body?.platform === 'string' ? body.platform.trim().toLowerCase() : '';
  if (!['windows', 'linux', 'macos'].includes(platform)) throw validationError('Платформа профиля: windows, linux или macos.');
  const platformVersion = cleanRequiredString(body?.platformVersion, 'Версия платформы', 64);
  const browserVersion = Number(body?.browserVersion);
  if (!Number.isInteger(browserVersion) || browserVersion < 1 || browserVersion > 999) throw validationError('Версия браузера должна быть целым числом от 1 до 999.');
  let folderId = null;
  if (body?.folderId !== undefined && body?.folderId !== null && String(body.folderId).trim() !== '') {
    folderId = Number(body.folderId);
    if (!Number.isSafeInteger(folderId) || folderId < 1) throw validationError('Идентификатор папки должен быть положительным целым числом.');
  }
  const rawTags = body?.tags === undefined || body?.tags === null ? [] : body.tags;
  if (!Array.isArray(rawTags)) throw validationError('Метки профиля должны быть списком.');
  if (rawTags.length > 30) throw validationError('Для профиля доступно не более 30 меток.');
  const tagKeys = new Set();
  const tags = rawTags.map(tag => {
    if (typeof tag !== 'string') throw validationError('Каждая метка профиля должна быть строкой.');
    const cleaned = tag.trim();
    if (!cleaned || cleaned.length > 64 || /[\u0000-\u001f\u007f]/.test(cleaned)) throw validationError('Метка профиля должна содержать от 1 до 64 допустимых символов.');
    return cleaned;
  }).filter(tag => {
    const key = tag.toLocaleLowerCase();
    if (tagKeys.has(key)) return false;
    tagKeys.add(key);
    return true;
  });
  return { name, platform, platformVersion, browserVersion, folderId, tags };
}
function fingerprintFromResponse(result) {
  if (isObjectRecord(result?.data)) return result.data;
  return isObjectRecord(result) ? result : {};
}
function publicTask(task) {
  const { wsEndpoint, profileResult, ...safe } = task;
  return safe;
}
function rejectTaskState(res, task, allowedStates, action) {
  if (allowedStates.includes(task.status)) return false;
  res.status(409).json({
    error: `Действие «${action}» недоступно для задачи в статусе «${task.status || 'неизвестно'}».`,
    code: 'invalid-task-state',
    task: publicTask(task),
    worker: workerState(),
  });
  return true;
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
  // Smoke tests use an isolated state file. They must never inspect or attach
  // to a real, already-open Dolphin browser on the workstation.
  if (isolatedState || process.env.CREATOR_FLOW_DISCOVER_RUNNING_PROFILES === '0') return null;
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
const LIBRARY_UPLOAD_MAX_BYTES = 750 * 1024 * 1024;
const libraryUploadExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
function libraryUploadError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
function requestContentLength(request) {
  const raw = request.headers['content-length'];
  if (Array.isArray(raw) || typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
function isOctetStreamRequest(request) {
  const raw = request.headers['content-type'];
  if (Array.isArray(raw) || typeof raw !== 'string') return false;
  return raw.split(';', 1)[0].trim().toLowerCase() === 'application/octet-stream';
}
function drainUploadRequest(request) {
  // Keep the connection reusable after an early validation failure without
  // accumulating the request body in memory.
  request.resume();
}
function waitForWritableDrain(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onError = error => finish(reject, error);
    const onClose = () => finish(reject, new Error('Временный файл загрузки был закрыт до записи.'));
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}
function finishWritable(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let finished = false;
    const cleanup = () => {
      stream.removeListener('finish', onFinish);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onFinish = () => {
      finished = true;
      if (stream.closed) finish(resolve);
    };
    const onError = error => finish(reject, error);
    const onClose = () => finished
      ? finish(resolve)
      : finish(reject, new Error('Временный файл загрузки был закрыт до завершения записи.'));
    stream.once('finish', onFinish);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.end();
  });
}
function closeWritable(stream) {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise(resolve => {
    stream.once('close', resolve);
    if (!stream.destroyed) stream.destroy();
  });
}
async function streamLibraryUpload(request, tempPath) {
  const declaredLength = requestContentLength(request);
  if (declaredLength !== null && declaredLength > LIBRARY_UPLOAD_MAX_BYTES) {
    drainUploadRequest(request);
    throw libraryUploadError('Размер файла не должен превышать 750 МБ.', 413, 'library-upload-too-large');
  }
  if (declaredLength === 0) {
    drainUploadRequest(request);
    throw libraryUploadError('Файл не получен.', 400, 'library-upload-empty');
  }

  const output = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
  let outputError = null;
  output.on('error', error => { outputError ||= error; });
  let receivedBytes = 0;
  // Node's iterator keeps the request streaming and, with this option, allows
  // us to drain an over-limit request rather than buffering or destroying it.
  const input = typeof request.iterator === 'function'
    ? request.iterator({ destroyOnReturn: false })
    : request;
  try {
    for await (const rawChunk of input) {
      if (outputError) throw outputError;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (receivedBytes + chunk.length > LIBRARY_UPLOAD_MAX_BYTES) {
        throw libraryUploadError('Размер файла не должен превышать 750 МБ.', 413, 'library-upload-too-large');
      }
      receivedBytes += chunk.length;
      if (!output.write(chunk)) await waitForWritableDrain(output);
    }
    if (outputError) throw outputError;
    if (receivedBytes === 0) throw libraryUploadError('Файл не получен.', 400, 'library-upload-empty');
    await finishWritable(output);
    return receivedBytes;
  } catch (error) {
    drainUploadRequest(request);
    await closeWritable(output);
    throw error;
  }
}

// Local media processing deliberately has a much smaller bound than the
// network/profile worker pool. FFmpeg is CPU and disk intensive, so a batch
// defaults to one encoder and can use at most three concurrent encoders.
const MAX_PROCESSING_BATCH_SIZE = 50;
// Campaigns are split into chunks of 50 jobs, but a campaign itself can be
// larger. Keep enough persisted batch history for several 500-output runs.
const MAX_PROCESSING_BATCHES = 120;
const MAX_PROCESSING_CONCURRENCY = 3;
const processingOutputExtensions = new Set(['.mp4']);

function processingError(message, statusCode = 400, code = 'processing-invalid') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeProcessingPath(value, label) {
  if (typeof value !== 'string') throw processingError(`${label} должен быть путём к файлу.`);
  const rawPath = value.trim();
  if (!rawPath || rawPath.length > 4_096 || rawPath.includes('\0')) {
    throw processingError(`${label} указан неверно.`);
  }
  return path.resolve(rawPath);
}

function normalizeProcessingOverlay(value) {
  if (value === undefined || value === null || value === '') return '';
  const overlayPath = normalizeProcessingPath(value, 'Путь к оверлею');
  const extension = path.extname(overlayPath).toLowerCase();
  if (extension !== '.png') throw processingError('Для оверлея поддерживается PNG-файл.');
  try {
    if (!fs.statSync(overlayPath).isFile()) throw new Error('not-a-file');
  } catch {
    throw processingError('PNG-оверлей не найден по указанному пути.');
  }
  return overlayPath;
}

function libraryOwnsProcessingInput(filePath) {
  return library.some(item => {
    try { return path.resolve(item.filePath) === filePath; }
    catch { return false; }
  });
}

async function normalizeProcessingJob(rawJob, index, seenInputs, seenOutputs) {
  if (!isObjectRecord(rawJob)) throw processingError(`Задача ${index + 1} должна быть объектом.`);
  const inputPath = normalizeProcessingPath(rawJob.inputPath, `Исходник ${index + 1}`);
  const outputPath = normalizeProcessingPath(rawJob.outputPath, `Выходной файл ${index + 1}`);
  if (!libraryOwnsProcessingInput(inputPath)) {
    throw processingError(`Исходник ${index + 1} нужно сначала добавить в библиотеку Creator Flow.`);
  }
  if (inputPath === outputPath) throw processingError(`Исходник и выходной файл ${index + 1} не должны совпадать.`);
  if (!processingOutputExtensions.has(path.extname(outputPath).toLowerCase())) {
    throw processingError(`Выходной файл ${index + 1} должен иметь расширение .mp4.`);
  }
  if (seenInputs.has(inputPath)) throw processingError(`Один исходник указан дважды (задача ${index + 1}).`);
  if (seenOutputs.has(outputPath)) throw processingError(`Один выходной путь указан дважды (задача ${index + 1}).`);
  let outputDirectory;
  try { outputDirectory = fs.statSync(path.dirname(outputPath)); }
  catch { throw processingError(`Папка для выходного файла ${index + 1} не найдена.`); }
  if (!outputDirectory.isDirectory()) throw processingError(`Папка для выходного файла ${index + 1} недоступна.`);
  if (fs.existsSync(outputPath)) throw processingError(`Выходной файл ${index + 1} уже существует. Укажите новый путь.`);
  const inputMetadata = await inspectMediaFile(inputPath, { ffprobeBin });
  if (!inputMetadata.hasVideo) throw processingError(`В исходнике ${index + 1} не найден видеопоток.`);
  const overlayPath = normalizeProcessingOverlay(rawJob.overlayPath);
  seenInputs.add(inputPath);
  seenOutputs.add(outputPath);
  return {
    id: crypto.randomUUID(),
    inputPath,
    outputPath,
    overlayPath,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: 'Ожидает свободный локальный обработчик.',
  };
}

function processingBatchSummary(batch) {
  const counts = (batch.items || []).reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    total: batch.items?.length || 0,
    queued: counts.queued || 0,
    running: counts.running || 0,
    completed: counts.completed || 0,
    failed: counts.error || 0,
    recoveryNeeded: counts['recovery-needed'] || 0,
  };
}

function refreshProcessingBatchStatus(batch) {
  const summary = processingBatchSummary(batch);
  const status = summary.running
    ? 'running'
    : summary.queued
      ? 'queued'
    : summary.recoveryNeeded
      ? 'needs-attention'
      : summary.failed
        ? 'completed-with-errors'
        : 'completed';
  if (batch.status !== status) {
    batch.status = status;
    batch.updatedAt = new Date().toISOString();
  }
  return summary;
}

function publicProcessingBatch(batch) {
  const summary = processingBatchSummary(batch);
  return {
    id: batch.id,
    source: 'own-media-batch',
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    status: batch.status,
    concurrency: batch.concurrency,
    autoRun: batch.autoRun === true,
    ...summary,
    items: (batch.items || []).map(item => ({
      id: item.id,
      inputPath: item.inputPath,
      outputPath: item.outputPath,
      overlayPath: item.overlayPath || '',
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      message: cleanAccountText(item.message, 600),
      error: cleanAccountText(item.error, 600),
      item: item.libraryItem ? { id: item.libraryItem.id, fileName: item.libraryItem.fileName, filePath: item.libraryItem.filePath } : null,
    })),
  };
}

function processingTempPath(item) {
  const extension = path.extname(item.outputPath) || '.mp4';
  const base = path.basename(item.outputPath, extension);
  return path.join(path.dirname(item.outputPath), `.${base}.${item.id}.processing${extension}`);
}

async function renderProcessingJob(item) {
  const temporaryPath = processingTempPath(item);
  if (fs.existsSync(item.outputPath)) throw processingError('Выходной файл уже существует. Для повторной обработки укажите новый путь.', 409, 'processing-output-exists');
  if (fs.existsSync(temporaryPath)) await fs.promises.rm(temporaryPath, { force: true });
  const args = item.recipe
    ? buildFfmpegArgs(validateEditorialRecipe(item.recipe), { outputPath: temporaryPath, overwrite: false })
    : (() => {
      const legacyArgs = ['-hide_banner', '-nostdin', '-n', '-i', item.inputPath];
      if (item.overlayPath) {
        legacyArgs.push('-i', item.overlayPath, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]', '-map', '[v]', '-map', '0:a?');
      } else {
        legacyArgs.push('-map', '0:v:0', '-map', '0:a?');
      }
      legacyArgs.push('-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', temporaryPath);
      return legacyArgs;
    })();
  try {
    await execFileAsync(ffmpegBin, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const metadata = await inspectMediaFile(temporaryPath, { ffprobeBin });
    if (!metadata.hasVideo) throw new Error('FFmpeg не создал выходной видеопоток.');
    await fs.promises.rename(temporaryPath, item.outputPath);
    return { ...metadata, filePath: item.outputPath, fileName: path.basename(item.outputPath) };
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function runProcessingBatchItem(batch, item) {
  item.status = 'running';
  item.error = '';
  item.message = 'FFmpeg обрабатывает исходный файл.';
  item.updatedAt = new Date().toISOString();
  refreshProcessingBatchStatus(batch);
  saveState();
  syncMediaCampaignProgress();
  try {
    if (!libraryOwnsProcessingInput(item.inputPath)) {
      throw processingError('Исходник больше не находится в библиотеке Creator Flow.');
    }
    const inputMetadata = await inspectMediaFile(item.inputPath, { ffprobeBin });
    if (!inputMetadata.hasVideo) throw processingError('В исходном файле больше не найден видеопоток.');
    if (item.overlayPath) normalizeProcessingOverlay(item.overlayPath);
    const metadata = await renderProcessingJob(item);
    const existing = library.find(entry => {
      try { return path.resolve(entry.filePath) === path.resolve(metadata.filePath); }
      catch { return false; }
    });
    if (item.addToLibrary !== false) {
      const libraryItem = existing || makeLibraryEntry(metadata, item.campaignId ? 'campaign-output' : 'processed-batch');
      if (!existing) library.unshift(libraryItem);
      item.libraryItem = { id: libraryItem.id, fileName: libraryItem.fileName, filePath: libraryItem.filePath };
    } else {
      delete item.libraryItem;
    }
    item.status = 'completed';
    item.message = item.addToLibrary === false
      ? 'Обработка завершена; готовый файл сохранён в указанной папке.'
      : 'Обработка завершена; отдельный выходной файл добавлен в библиотеку.';
    addLog(`Пакетная обработка завершена: ${metadata.fileName}`, null, 'info');
  } catch (error) {
    item.status = 'error';
    item.error = cleanAccountText(error.message, 600);
    item.message = 'Выходной файл не создан. Проверьте пути и повторите задачу только после исправления причины.';
    addLog(`Ошибка пакетной обработки: ${item.error || 'неизвестная ошибка'}`, null, 'error');
  }
  item.updatedAt = new Date().toISOString();
  refreshProcessingBatchStatus(batch);
  saveState();
  syncMediaCampaignProgress();
  return item;
}

function startProcessingBatchItem(batch, item) {
  if (activeProcessingJobIds.has(item.id)) return { started: false, code: 'processing-already-running' };
  if (activeProcessingOutputPaths.has(item.outputPath)) return { started: false, code: 'processing-output-busy' };
  activeProcessingJobIds.add(item.id);
  activeProcessingOutputPaths.add(item.outputPath);
  const promise = runProcessingBatchItem(batch, item)
    .finally(() => {
      activeProcessingJobIds.delete(item.id);
      activeProcessingOutputPaths.delete(item.outputPath);
      if (backgroundEnabled) {
        queueMicrotask(() => processProcessingBatches().catch(error => addLog(`Ошибка очереди обработки файлов: ${error.message}`, null, 'error')));
      }
    });
  return { started: true, promise };
}

async function processProcessingBatches() {
  if (processingBatchPumpRunning) return;
  processingBatchPumpRunning = true;
  try {
    for (const batch of processingBatches) {
      if (!['queued', 'running'].includes(batch.status)) continue;
      if (batch.autoRun !== true) continue;
      const limit = Math.min(Math.max(Number(batch.concurrency) || 1, 1), MAX_PROCESSING_CONCURRENCY);
      while (activeProcessingJobIds.size < MAX_PROCESSING_CONCURRENCY) {
        const batchActive = (batch.items || []).filter(item => activeProcessingJobIds.has(item.id)).length;
        if (batchActive >= limit) break;
        const item = (batch.items || []).find(candidate => (
          candidate.status === 'queued'
          && !activeProcessingJobIds.has(candidate.id)
          && !activeProcessingOutputPaths.has(candidate.outputPath)
        ));
        if (!item) break;
        const operation = startProcessingBatchItem(batch, item);
        if (!operation.started) break;
        operation.promise.catch(error => addLog(`Ошибка локальной обработки: ${error.message}`, null, 'error'));
      }
      refreshProcessingBatchStatus(batch);
    }
    saveState();
  } finally {
    processingBatchPumpRunning = false;
  }
}

function assertProcessingRetryable(item) {
  if (!['error', 'recovery-needed'].includes(item.status)) {
    throw processingError('Повторно можно запускать только задачу с ошибкой или прерванную перезапуском.', 409, 'processing-invalid-state');
  }
  if (fs.existsSync(item.outputPath)) {
    throw processingError('По этому пути уже есть выходной файл. Проверьте его и укажите новый путь для повторной обработки.', 409, 'processing-output-exists');
  }
}

function queueProcessingRetry(batch, item) {
  assertProcessingRetryable(item);
  item.status = 'queued';
  item.error = '';
  item.message = 'Повторно поставлена в очередь обработки.';
  item.updatedAt = new Date().toISOString();
  refreshProcessingBatchStatus(batch);
  saveState();
}

// Campaigns are the higher-level uniqueizer workflow.  They keep the
// requested source-to-output plan and split the actual FFmpeg work into
// bounded processing batches.  The split is an implementation detail: the
// operator sees one campaign with one coherent progress view.
const MAX_MEDIA_CAMPAIGNS = 40;
const MAX_CAMPAIGN_PROFILES = 20;
const MAX_CAMPAIGN_TAGS = 50;

function campaignError(message, statusCode = 400, code = 'campaign-invalid') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeCampaignText(value, label, { required = false, maxLength = 5000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw campaignError(`${label} is required.`, 400, 'campaign-required');
    return '';
  }
  if (typeof value !== 'string') throw campaignError(`${label} must be text.`, 400, 'campaign-invalid-text');
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (!result && required) throw campaignError(`${label} is required.`, 400, 'campaign-required');
  if (result.length > maxLength) throw campaignError(`${label} is too long.`, 400, 'campaign-text-too-long');
  return result;
}

function normalizeCampaignOutputCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_EDITORIAL_CAMPAIGN_OUTPUTS) {
    throw campaignError(`Choose an integer output count from 1 to ${MAX_EDITORIAL_CAMPAIGN_OUTPUTS}.`, 422, 'campaign-output-count');
  }
  return count;
}

function campaignLibrarySource(rawPath, index) {
  const filePath = normalizeProcessingPath(rawPath, `Campaign source ${index + 1}`);
  const item = library.find(entry => {
    try { return path.resolve(entry.filePath) === filePath; }
    catch { return false; }
  });
  if (!item) throw campaignError(`Campaign source ${index + 1} must first be added to the local library.`, 422, 'campaign-source-not-library');
  if (item.hasVideo === false) throw campaignError(`Campaign source ${index + 1} does not contain a video stream.`, 422, 'campaign-source-no-video');
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('not-a-file');
  } catch {
    throw campaignError(`Campaign source ${index + 1} is no longer available on disk.`, 422, 'campaign-source-missing');
  }
  return {
    id: String(item.id || filePath),
    filePath,
    fileName: item.fileName || path.basename(filePath),
    hasAudio: item.hasAudio === true,
  };
}

function normalizeCampaignSources(body) {
  const raw = Array.isArray(body?.sourcePaths) ? body.sourcePaths : body?.sourcePaths === undefined && Array.isArray(body?.sourceIds) ? body.sourceIds : null;
  if (!Array.isArray(raw) || raw.length === 0) throw campaignError('Choose at least one source video from the local library.', 400, 'campaign-sources-required');
  if (raw.length > MAX_EDITORIAL_CAMPAIGN_OUTPUTS) throw campaignError(`A campaign can use at most ${MAX_EDITORIAL_CAMPAIGN_OUTPUTS} sources.`, 422, 'campaign-too-many-sources');
  const seen = new Set();
  const sources = [];
  raw.forEach((value, index) => {
    let filePath;
    if (typeof value === 'string') {
      const byId = library.find(item => String(item.id) === value.trim());
      filePath = byId?.filePath || value;
    }
    else if (typeof value === 'number') {
      const found = library.find(item => String(item.id) === String(value));
      filePath = found?.filePath || '';
    } else if (isObjectRecord(value)) filePath = value.filePath || value.path || '';
    else filePath = '';
    const source = campaignLibrarySource(filePath, index);
    if (!seen.has(source.filePath)) {
      seen.add(source.filePath);
      sources.push(source);
    }
  });
  if (!sources.length) throw campaignError('Choose at least one valid source video.', 422, 'campaign-sources-required');
  return sources;
}

function normalizeCampaignOutputFolder(value) {
  const outputFolder = normalizeProcessingPath(value, 'Output folder');
  try {
    if (!fs.statSync(outputFolder).isDirectory()) throw new Error('not-a-directory');
  } catch {
    throw campaignError('The output folder does not exist or is not accessible.', 422, 'campaign-output-folder');
  }
  return outputFolder;
}

function normalizeCampaignOutputTemplate(value) {
  const template = normalizeCampaignText(value, 'Output filename template', { required: true, maxLength: 255 });
  if (template.includes('/') || template.includes('\\') || path.basename(template) !== template) {
    throw campaignError('The output filename template must not include folders.', 422, 'campaign-output-template');
  }
  if (!template.toLowerCase().endsWith('.mp4')) {
    throw campaignError('The output filename template must end in .mp4.', 422, 'campaign-output-template');
  }
  return template;
}

function campaignSourceName(source) {
  return path.basename(source.fileName || source.filePath, path.extname(source.fileName || source.filePath)) || 'video';
}

function campaignOutputPath(outputFolder, template, source, outputIndex, campaignId) {
  const rendered = template
    .replaceAll('{source}', campaignSourceName(source))
    .replaceAll('{index}', String(outputIndex))
    .replaceAll('{campaign}', String(campaignId).slice(0, 8));
  const fileName = safeFileName(rendered);
  if (!fileName.toLowerCase().endsWith('.mp4')) throw campaignError('The output template produced an invalid .mp4 filename.', 422, 'campaign-output-template');
  return path.join(outputFolder, fileName);
}

function processingOutputIsReserved(outputPath) {
  let normalized;
  try { normalized = path.resolve(outputPath); }
  catch { return true; }
  return processingBatches.some(batch => (batch.items || []).some(item => {
    try { return path.resolve(item.outputPath) === normalized; }
    catch { return false; }
  }));
}

function normalizeCampaignProfileIds(rawIds, enabled) {
  if (!enabled) return [];
  const normalized = normalizeBulkProfileIds(rawIds);
  if (normalized.error) throw campaignError(normalized.error, 400, 'campaign-profiles');
  if (normalized.profileIds.length > MAX_CAMPAIGN_PROFILES) {
    throw campaignError(`Choose no more than ${MAX_CAMPAIGN_PROFILES} profiles for one campaign.`, 422, 'campaign-too-many-profiles');
  }
  return normalized.profileIds;
}

const CAMPAIGN_TEXT_COLORS = Object.freeze([
  '#FFFFFF', '#45C873', '#FFD166', '#79B8FF', '#F58FB7', '#C9A7FF', '#FF9D66',
]);

function campaignTextColor(mode, outputIndex) {
  if (mode === 'white') return '#FFFFFF';
  if (mode === 'accent') return '#45C873';
  if (mode && mode !== 'random-visible') {
    throw campaignError('Text color mode is not supported.', 422, 'campaign-text-color');
  }
  return CAMPAIGN_TEXT_COLORS[(outputIndex - 1) % CAMPAIGN_TEXT_COLORS.length];
}

function normalizeCampaignTextVariations(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) {
    throw campaignError('Text variations must be a list of text lines.', 422, 'campaign-text-variations');
  }
  if (raw.length > 250) throw campaignError('Use no more than 250 text variations.', 422, 'campaign-text-variations');
  const values = raw
    .map(value => normalizeCampaignText(value, 'Text variation', { maxLength: 280 }))
    .filter(Boolean);
  if (values.length !== raw.length) {
    throw campaignError('Text variations must not be empty.', 422, 'campaign-text-variations');
  }
  return values;
}

function defaultCampaignFontPath() {
  const candidates = [
    process.env.CREATOR_FLOW_DEFAULT_FONT,
    process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.statSync(resolved).isFile() && ['.ttf', '.otf'].includes(path.extname(resolved).toLowerCase())) return resolved;
    } catch { /* Try the next explicit local font candidate. */ }
  }
  return '';
}

function normalizeCampaignFontPath(raw) {
  const requested = normalizeCampaignText(raw, 'Font path', { maxLength: 4_096 });
  const fontPath = requested ? path.resolve(requested) : defaultCampaignFontPath();
  if (!fontPath) {
    throw campaignError('Choose a .ttf or .otf font file for visible text.', 422, 'campaign-font-required');
  }
  if (!['.ttf', '.otf'].includes(path.extname(fontPath).toLowerCase())) {
    throw campaignError('Text font must use a .ttf or .otf file.', 422, 'campaign-font-extension');
  }
  try {
    if (!fs.statSync(fontPath).isFile()) throw new Error('not-a-file');
  } catch {
    throw campaignError('The selected text font was not found.', 422, 'campaign-font-missing');
  }
  return fontPath;
}

function normalizeCampaignPresetId(body) {
  const raw = body?.presetId ?? body?.recipe?.presetId ?? 'manual';
  if (typeof raw !== 'string') {
    throw campaignError('Preset must be a text value.', 400, 'campaign-preset-invalid');
  }
  const presetId = raw.trim().toLowerCase() || 'manual';
  if (!listEditorialPresets().some(preset => preset.id === presetId)) {
    throw campaignError('The selected uniqueizer preset is not supported.', 422, 'campaign-preset-invalid');
  }
  return presetId;
}

function normalizeCampaignRecipeInput(raw, source, outputIndex) {
  const input = isObjectRecord(raw) ? raw : {};
  const layout = ['vertical-9x16', 'square-1x1', 'keep'].includes(input.layout) ? input.layout : 'vertical-9x16';
  const cropMode = ['smart', 'fit', 'none'].includes(input.crop) ? input.crop : 'smart';
  const speedMin = Number(input.speedMin ?? 1);
  const speedMax = Number(input.speedMax ?? speedMin);
  if (!Number.isFinite(speedMin) || !Number.isFinite(speedMax) || speedMin < 0.95 || speedMax > 1.05 || speedMin > speedMax) {
    throw campaignError('Playback speed must be between 0.95 and 1.05.', 422, 'campaign-speed-range');
  }
  // Cycling through seven visible pace values gives each planned output an
  // explicit recipe.  The actual pace is persisted and shown in the campaign;
  // it is never a hidden fingerprinting change.
  const step = ((outputIndex - 1) % 7) / 6;
  const pace = Math.round((speedMin + (speedMax - speedMin) * step) * 10_000) / 10_000;
  let crop = null;
  let scale = null;
  if (layout !== 'keep') {
    const aspect = layout === 'vertical-9x16' ? '9:16' : '1:1';
    const width = 1080;
    const height = layout === 'vertical-9x16' ? 1920 : 1080;
    if (cropMode === 'smart') {
      crop = { aspect, position: 'center' };
      scale = { width, height, fit: 'stretch' };
    } else {
      // “Fit” and “do not crop” preserve the entire source with padding.
      scale = { width, height, fit: 'contain' };
    }
  }
  const overlayPath = normalizeProcessingOverlay(input.overlayPath);
  let overlay = null;
  if (overlayPath) {
    const overlayOpacity = Number(input.overlayOpacity ?? 1);
    const overlayWidth = Number(input.overlayWidth ?? 240);
    const overlayBlurMinPx = Number(input.overlayBlurMin ?? 0);
    const overlayBlurMaxPx = Number(input.overlayBlurMax ?? overlayBlurMinPx);
    const overlayPosition = String(input.overlayPosition || 'bottom-right');
    if (!Number.isFinite(overlayOpacity) || overlayOpacity < 0.05 || overlayOpacity > 1) {
      throw campaignError('Overlay opacity must be between 5% and 100%.', 422, 'campaign-overlay-opacity');
    }
    if (!Number.isInteger(overlayWidth) || overlayWidth < 2 || overlayWidth > 7_680 || overlayWidth % 2 !== 0) {
      throw campaignError('Overlay width must be an even number from 2 to 7680.', 422, 'campaign-overlay-width');
    }
    if (!Number.isFinite(overlayBlurMinPx) || !Number.isFinite(overlayBlurMaxPx)
      || overlayBlurMinPx < 0 || overlayBlurMaxPx > 20 || overlayBlurMinPx > overlayBlurMaxPx) {
      throw campaignError('Overlay blur must be a range from 0 to 20 px.', 422, 'campaign-overlay-blur');
    }
    overlay = {
      filePath: overlayPath,
      position: overlayPosition,
      opacity: overlayOpacity,
      width: overlayWidth,
      margin: 24,
      // The engine accepts a declared 0..1 amount.  The UI displays the
      // equivalent visible 0..20 px range, and every resolved value is kept
      // in the persisted recipe for inspection.
      blur: { min: overlayBlurMinPx / 20, max: overlayBlurMaxPx / 20 },
    };
  }

  const textVariations = normalizeCampaignTextVariations(input.textVariations);
  let text = null;
  if (textVariations.length) {
    const textSize = Number(input.textSize ?? 70);
    const textY = Number(input.textY ?? 65);
    if (!Number.isInteger(textSize) || textSize < 8 || textSize > 512) {
      throw campaignError('Text size must be an integer from 8 to 512 px.', 422, 'campaign-text-size');
    }
    if (!Number.isFinite(textY) || textY < 5 || textY > 95) {
      throw campaignError('Text position must be between 5% and 95%.', 422, 'campaign-text-position');
    }
    text = {
      value: textVariations[(outputIndex - 1) % textVariations.length],
      fontFile: normalizeCampaignFontPath(input.fontPath),
      size: textSize,
      position: 'bottom-center',
      yPercent: textY,
      color: campaignTextColor(input.textColorMode, outputIndex),
      outline: input.textOutline === true,
      margin: 48,
    };
  }

  let color = null;
  if (input.colorCorrectionEnabled === true) {
    const amount = Number(input.colorStrength ?? 35);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100) {
      throw campaignError('Color correction amount must be between 0% and 100%.', 422, 'campaign-color-strength');
    }
    if (amount > 0) {
      color = { level: amount <= 35 ? 'weak' : amount <= 70 ? 'medium' : 'strong', amount };
    }
  }

  let video = null;
  const requestedFps = input.fps;
  const requestedBitrate = input.bitrateKbps;
  if (requestedFps !== undefined && requestedFps !== null && requestedFps !== '' && requestedFps !== 'keep'
    || requestedBitrate !== undefined && requestedBitrate !== null && requestedBitrate !== '') {
    video = {};
    if (requestedFps !== undefined && requestedFps !== null && requestedFps !== '' && requestedFps !== 'keep') {
      const fps = Number(requestedFps);
      if (!Number.isInteger(fps) || fps < 12 || fps > 120) {
        throw campaignError('FPS must be an integer from 12 to 120, or “keep”.', 422, 'campaign-fps');
      }
      video.fps = fps;
    }
    if (requestedBitrate !== undefined && requestedBitrate !== null && requestedBitrate !== '') {
      const bitrateKbps = Number(requestedBitrate);
      if (!Number.isInteger(bitrateKbps) || bitrateKbps < 100 || bitrateKbps > 100_000) {
        throw campaignError('Video bitrate must be an integer from 100 to 100000 Kbit/s.', 422, 'campaign-bitrate');
      }
      video.bitrateKbps = bitrateKbps;
    }
    if (!Object.keys(video).length) video = null;
  }
  const audioMode = String(input.audioMode || 'original');
  const musicPath = normalizeCampaignText(input.audioPath, 'Background audio path', { maxLength: 4096 });
  let audio;
  if (musicPath) {
    try {
      if (!fs.statSync(path.resolve(musicPath)).isFile()) throw new Error('not-a-file');
    } catch {
      throw campaignError('The background audio file was not found.', 422, 'campaign-audio-missing');
    }
    if (!source.hasAudio) throw campaignError('Mixing a background track requires a source with an audio stream.', 422, 'campaign-audio-source');
    audio = { mode: 'mix', musicPath: path.resolve(musicPath), sourceGainDb: 0, musicGainDb: -16 };
  } else if (audioMode === 'mute') {
    audio = { mode: 'mute' };
  } else if (audioMode === 'normalize' && source.hasAudio) {
    // The available recipe uses a small, explicit gain adjustment; it is
    // recorded as such instead of claiming unknown loudness normalization.
    audio = { mode: 'gain', gainDb: -1 };
  } else {
    audio = { mode: 'keep' };
  }
  if (input.metadataMode && input.metadataMode !== 'clean') {
    throw campaignError('Campaign exports use technical metadata cleanup. The original metadata is kept only in the campaign record.', 422, 'campaign-metadata-mode');
  }
  return { crop, scale, pace, overlay, text, color, video, audio };
}

function normalizeCampaignTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) throw campaignError('Tags must be a list of text values.', 400, 'campaign-tags');
  if (raw.length > MAX_CAMPAIGN_TAGS) throw campaignError(`Use no more than ${MAX_CAMPAIGN_TAGS} tags.`, 422, 'campaign-tags');
  return [...new Set(raw.map(item => normalizeCampaignText(item, 'Tag', { maxLength: 100 })).filter(Boolean))];
}

function normalizeCampaignSchedule(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw campaignError('Scheduled time must be a valid ISO date.', 400, 'campaign-schedule');
  return new Date(value).toISOString();
}

function campaignTemplateValue(template, assignment, campaign) {
  return String(template || '')
    .replaceAll('{index}', String(assignment.outputIndex))
    .replaceAll('{source}', assignment.sourceName)
    .replaceAll('{profileId}', assignment.profileId || '')
    .replaceAll('{profile}', assignment.profileId || '')
    .replaceAll('{campaign}', String(campaign.id).slice(0, 8));
}

function findCampaignProcessingItem(assignment) {
  const batch = processingBatches.find(candidate => candidate.id === assignment.processingBatchId);
  return batch?.items?.find(candidate => candidate.id === assignment.processingItemId) || null;
}

function findCampaignUploadTask(assignment) {
  return assignment.uploadTaskId ? tasks.find(task => task.id === assignment.uploadTaskId) : null;
}

function campaignSummary(campaign) {
  const summary = { total: campaign.assignments?.length || 0, queued: 0, processing: 0, completed: 0, prepared: 0, awaitingReview: 0, errors: 0, recoveryNeeded: 0 };
  for (const assignment of campaign.assignments || []) {
    const status = assignment.status || 'queued';
    if (status === 'processing') summary.processing += 1;
    else if (status === 'completed') summary.completed += 1;
    else if (status === 'ready-for-upload') summary.prepared += 1;
    else if (status === 'awaiting-review') summary.awaitingReview += 1;
    else if (status === 'error') summary.errors += 1;
    else if (status === 'recovery-needed') summary.recoveryNeeded += 1;
    else summary.queued += 1;
  }
  return summary;
}

function refreshMediaCampaignStatus(campaign) {
  const summary = campaignSummary(campaign);
  const total = summary.total;
  let status = 'queued';
  if (!total) status = 'needs-attention';
  else if (summary.processing) status = 'running';
  else if (summary.queued) status = 'queued';
  else if (summary.recoveryNeeded || summary.errors) status = 'needs-attention';
  else if (summary.awaitingReview) status = 'awaiting-review';
  else if (summary.prepared) status = 'ready-for-upload';
  else if (summary.completed === total) status = 'completed';
  if (campaign.status !== status) {
    campaign.status = status;
    campaign.updatedAt = new Date().toISOString();
  }
  return summary;
}

function publicMediaCampaign(campaign) {
  const summary = campaignSummary(campaign);
  return {
    id: campaign.id,
    name: campaign.name || '',
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    status: campaign.status,
    autoRun: campaign.autoRun === true,
    presetId: campaign.presetId || 'manual',
    distributionEnabled: campaign.distributionEnabled === true,
    sourcePaths: campaign.sourcePaths || [],
    outputCount: campaign.outputCount,
    outputFolder: campaign.outputFolder,
    outputTemplate: campaign.outputTemplate,
    profileIds: campaign.profileIds || [],
    processingConcurrency: campaign.processingConcurrency,
    uploadConcurrency: campaign.uploadConcurrency,
    scheduledAt: campaign.scheduledAt || null,
    duplicateRenderGroups: campaign.duplicateRenderGroups || [],
    ...summary,
    assignments: (campaign.assignments || []).map(assignment => ({
      id: assignment.id,
      outputIndex: assignment.outputIndex,
      sourceName: assignment.sourceName,
      sourcePath: assignment.sourcePath,
      outputPath: assignment.outputPath,
      profileId: assignment.profileId || '',
      status: assignment.status,
      message: cleanAccountText(assignment.message, 600),
      error: cleanAccountText(assignment.error, 600),
      recipe: assignment.recipe ? {
        recipeId: assignment.recipe.recipeId,
        renderSignature: assignment.recipe.renderSignature,
        materialChanges: assignment.recipe.materialChanges || [],
        edits: assignment.recipe.edits,
      } : null,
      duplicateRenderGroupSize: assignment.duplicateRenderGroupSize || 1,
      uploadTaskId: assignment.uploadTaskId || null,
      uploadStatus: assignment.uploadStatus || null,
      updatedAt: assignment.updatedAt,
    })),
  };
}

function createCampaignUploadTask(campaign, assignment) {
  if (!campaign.distributionEnabled || !assignment.profileId || assignment.uploadTaskId) return false;
  const title = campaignTemplateValue(campaign.titleTemplate, assignment, campaign).trim();
  if (!title || title.length > 100) {
    assignment.status = 'error';
    assignment.error = 'The title template produced an invalid title for this output.';
    assignment.message = 'Задание загрузки не создано: проверьте шаблон заголовка.';
    return true;
  }
  const description = campaignTemplateValue(campaign.descriptionTemplate, assignment, campaign);
  if (description.length > 5000) {
    assignment.status = 'error';
    assignment.error = 'The description template produced text longer than 5000 characters.';
    assignment.message = 'Задание загрузки не создано: описание слишком длинное.';
    return true;
  }
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    profileId: assignment.profileId,
    videoPath: assignment.outputPath,
    title,
    description,
    tags: campaign.tags || [],
    scheduledAt: campaign.scheduledAt || null,
    // A campaign prepares a real Studio upload task but never performs a
    // browser action merely because rendering has completed.
    autoUpload: false,
    source: 'campaign-upload-plan',
    campaignId: campaign.id,
    campaignAssignmentId: assignment.id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  assignment.uploadTaskId = task.id;
  assignment.uploadStatus = task.status;
  assignment.status = 'ready-for-upload';
  assignment.message = 'Готовый файл добавлен в план загрузки выбранного профиля.';
  assignment.updatedAt = now;
  return true;
}

function syncMediaCampaignProgress() {
  let changed = false;
  for (const campaign of mediaCampaigns) {
    for (const assignment of campaign.assignments || []) {
      const processingItem = findCampaignProcessingItem(assignment);
      if (processingItem) {
        const next = processingItem.status === 'running' ? 'processing'
          : processingItem.status === 'completed' ? (campaign.distributionEnabled ? 'ready-for-upload' : 'completed')
            : processingItem.status === 'error' ? 'error'
              : processingItem.status === 'recovery-needed' ? 'recovery-needed'
                : 'queued';
        if (assignment.status !== next || assignment.error !== (processingItem.error || '') || assignment.message !== (processingItem.message || '')) {
          assignment.status = next;
          assignment.error = processingItem.error || '';
          assignment.message = processingItem.message || '';
          assignment.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (processingItem.status === 'completed' && createCampaignUploadTask(campaign, assignment)) changed = true;
      }
      const uploadTask = findCampaignUploadTask(assignment);
      if (uploadTask) {
        const uploadStatus = uploadTask.status;
        if (assignment.uploadStatus !== uploadStatus) {
          assignment.uploadStatus = uploadStatus;
          if (uploadStatus === 'awaiting-review') assignment.status = 'awaiting-review';
          else if (uploadStatus === 'error') { assignment.status = 'error'; assignment.error = uploadTask.error || assignment.error; }
          else if (uploadStatus === 'cancelled') assignment.status = 'ready-for-upload';
          assignment.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    const before = campaign.status;
    refreshMediaCampaignStatus(campaign);
    if (campaign.status !== before) changed = true;
  }
  if (changed) saveState();
  return changed;
}

function createMediaCampaign(body) {
  const sources = normalizeCampaignSources(body);
  const outputCount = normalizeCampaignOutputCount(body?.outputCount);
  const outputFolder = normalizeCampaignOutputFolder(body?.outputFolder);
  const outputTemplate = normalizeCampaignOutputTemplate(body?.outputTemplate);
  const distributionEnabled = body?.distributionEnabled === true;
  const profileIds = normalizeCampaignProfileIds(body?.profileIds, distributionEnabled);
  const processingConcurrency = body?.processingConcurrency === undefined ? 1 : Number(body.processingConcurrency);
  if (!Number.isInteger(processingConcurrency) || processingConcurrency < 1 || processingConcurrency > MAX_PROCESSING_CONCURRENCY) {
    throw campaignError(`Choose from 1 to ${MAX_PROCESSING_CONCURRENCY} local processing workers.`, 422, 'campaign-processing-concurrency');
  }
  const uploadConcurrency = body?.uploadConcurrency === undefined ? 1 : Number(body.uploadConcurrency);
  if (!Number.isInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > MAX_CAMPAIGN_PROFILES) {
    throw campaignError(`Choose from 1 to ${MAX_CAMPAIGN_PROFILES} upload workers.`, 422, 'campaign-upload-concurrency');
  }
  const titleTemplate = normalizeCampaignText(body?.titleTemplate, 'Title template', { required: distributionEnabled, maxLength: 100 });
  const descriptionTemplate = normalizeCampaignText(body?.descriptionTemplate, 'Description template', { maxLength: 5000 });
  const tags = normalizeCampaignTags(body?.tags);
  const scheduledAt = normalizeCampaignSchedule(body?.scheduledAt);
  const autoRun = body?.autoStart === true;
  const addToLibrary = body?.recipe?.addToLibrary !== false;
  const campaignId = crypto.randomUUID();
  const presetId = normalizeCampaignPresetId(body);
  const now = new Date().toISOString();
  const seenOutputs = new Set();
  const assignments = [];
  const chunks = [];
  let chunkItems = [];
  for (let outputIndex = 1; outputIndex <= outputCount; outputIndex += 1) {
    const source = sources[(outputIndex - 1) % sources.length];
    const outputPath = campaignOutputPath(outputFolder, outputTemplate, source, outputIndex, campaignId);
    if (seenOutputs.has(outputPath)) throw campaignError('The output filename template creates duplicate paths. Include {index} in the filename.', 422, 'campaign-duplicate-output');
    if (fs.existsSync(outputPath)) throw campaignError(`Output file already exists: ${path.basename(outputPath)}`, 409, 'campaign-output-exists');
    if (processingOutputIsReserved(outputPath)) {
      throw campaignError(`Another local processing task already reserves: ${path.basename(outputPath)}`, 409, 'campaign-output-reserved');
    }
    seenOutputs.add(outputPath);
    const profileId = distributionEnabled ? profileIds[(outputIndex - 1) % profileIds.length] : '';
    const baseEdits = normalizeCampaignRecipeInput(body?.recipe, source, outputIndex);
    const edits = resolveEditorialPreset({
      presetId,
      baseEdits,
      source: { id: source.id, filePath: source.filePath, hasAudio: source.hasAudio },
      campaignId,
      variantIndex: outputIndex,
      profileId: profileId || 'local-render',
    });
    const recipe = createEditorialRecipe({ source: { id: source.id, filePath: source.filePath, hasAudio: source.hasAudio }, campaignId, variantIndex: outputIndex, profileId: profileId || 'local-render', edits });
    const assignmentId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const assignment = {
      id: assignmentId,
      outputIndex,
      sourceName: campaignSourceName(source),
      sourcePath: source.filePath,
      outputPath,
      profileId,
      status: 'queued',
      message: 'Ожидает запуска локальной обработки.',
      error: '',
      recipe,
      createdAt: now,
      updatedAt: now,
      processingItemId: itemId,
      processingBatchId: '',
    };
    const item = {
      id: itemId,
      inputPath: source.filePath,
      outputPath,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      message: 'Ожидает запуска локальной обработки.',
      error: '',
      recipe,
      addToLibrary,
      campaignId,
      campaignAssignmentId: assignmentId,
    };
    assignments.push(assignment);
    chunkItems.push(item);
    if (chunkItems.length === MAX_PROCESSING_BATCH_SIZE || outputIndex === outputCount) {
      chunks.push(chunkItems);
      chunkItems = [];
    }
  }
  if (mediaCampaigns.length >= MAX_MEDIA_CAMPAIGNS) throw campaignError(`Keep no more than ${MAX_MEDIA_CAMPAIGNS} saved campaigns.`, 409, 'campaign-history-full');
  if (processingBatches.length + chunks.length > MAX_PROCESSING_BATCHES) {
    throw campaignError('The local processing history is full. Finish or remove old processing batches before creating this campaign.', 409, 'campaign-processing-capacity');
  }
  const campaign = {
    id: campaignId,
    name: normalizeCampaignText(body?.name, 'Campaign name', { maxLength: 120 }) || `Кампания ${now.slice(0, 16).replace('T', ' ')}`,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    autoRun,
    presetId,
    distributionEnabled,
    sourcePaths: sources.map(source => source.filePath),
    outputCount,
    outputFolder,
    outputTemplate,
    profileIds,
    titleTemplate,
    descriptionTemplate,
    tags,
    scheduledAt,
    processingConcurrency,
    uploadConcurrency,
    assignments,
    duplicateRenderGroups: [],
    processingBatchIds: [],
  };
  const signatureGroups = new Map();
  for (const assignment of assignments) {
    const group = signatureGroups.get(assignment.recipe.renderSignature) || [];
    group.push(assignment);
    signatureGroups.set(assignment.recipe.renderSignature, group);
  }
  campaign.duplicateRenderGroups = [...signatureGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([renderSignature, group]) => ({ renderSignature, outputIndexes: group.map(item => item.outputIndex) }));
  for (const group of signatureGroups.values()) {
    for (const assignment of group) assignment.duplicateRenderGroupSize = group.length;
  }
  const batches = chunks.map(items => {
    const batch = {
      id: crypto.randomUUID(),
      source: 'campaign-processing',
      campaignId,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      concurrency: processingConcurrency,
      autoRun: false,
      items,
    };
    for (const item of items) {
      const assignment = assignments.find(candidate => candidate.id === item.campaignAssignmentId);
      if (assignment) assignment.processingBatchId = batch.id;
    }
    campaign.processingBatchIds.push(batch.id);
    refreshProcessingBatchStatus(batch);
    return batch;
  });
  refreshMediaCampaignStatus(campaign);
  return { campaign, batches };
}

const MAX_BULK_UPLOAD_TASKS = 100;
function normalizeBulkProfileIds(rawIds) {
  if (!Array.isArray(rawIds)) return { error: 'profileIds must be an array.' };
  const invalid = [];
  const profileIds = [];
  const seen = new Set();
  rawIds.forEach((value, index) => {
    if (typeof value !== 'string' && typeof value !== 'number') {
      invalid.push(index + 1);
      return;
    }
    const profileId = String(value).trim();
    if (!profileId || profileId.length > 128 || /[\u0000-\u001f\u007f\s]/.test(profileId)) {
      invalid.push(index + 1);
      return;
    }
    if (!seen.has(profileId)) {
      seen.add(profileId);
      profileIds.push(profileId);
    }
  });
  if (invalid.length) return { error: `profileIds contains invalid values at positions: ${invalid.join(', ')}.` };
  if (!profileIds.length) return { error: 'Choose at least one Dolphin profile.' };
  if (profileIds.length > MAX_BULK_UPLOAD_TASKS) return { error: `A bulk queue can contain at most ${MAX_BULK_UPLOAD_TASKS} profiles.` };
  return { profileIds };
}
function validateBulkVideoPath(value) {
  if (typeof value !== 'string') return { error: 'videoPath must be a file path.' };
  const rawPath = value.trim();
  if (!rawPath || rawPath.includes('\0')) return { error: 'videoPath must be a non-empty file path.' };
  const videoPath = path.resolve(rawPath);
  try {
    if (!fs.statSync(videoPath).isFile()) return { error: 'videoPath must point to an existing file.' };
  } catch {
    return { error: 'videoPath must point to an existing file.' };
  }
  return { videoPath };
}
function fillBulkTitleTemplate(titleTemplate, profileId, index) {
  return titleTemplate
    .replaceAll('{index}', String(index))
    .replaceAll('{profileId}', profileId);
}
const MAX_BULK_CHANNEL_TASKS = 100;
const MAX_CHANNEL_LINKS = 20;
function hasUnsafeTextControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function normalizeChannelTemplate(value, label, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw validationError(`${label} должно быть строкой.`);
  const text = value.trim();
  if (text.length > maxLength || hasUnsafeTextControl(text)) {
    throw validationError(`${label} содержит недопустимые символы или превышает лимит ${maxLength} символов.`);
  }
  return text;
}
function normalizeChannelLinks(rawLinks) {
  if (rawLinks === undefined || rawLinks === null) return [];
  if (!Array.isArray(rawLinks)) throw validationError('Ссылки должны быть списком.');
  if (rawLinks.length > MAX_CHANNEL_LINKS) throw validationError(`Для задачи доступно не более ${MAX_CHANNEL_LINKS} ссылок.`);
  return rawLinks.map((link, index) => {
    if (!isObjectRecord(link)) throw validationError(`Ссылка ${index + 1} указана неверно.`);
    const title = normalizeChannelTemplate(link.title, `Название ссылки ${index + 1}`, 100);
    const rawUrl = normalizeChannelTemplate(link.url, `URL ссылки ${index + 1}`, 2_048);
    if (!title || !rawUrl) throw validationError(`Заполните название и URL для ссылки ${index + 1}.`);
    let url;
    try { url = new URL(rawUrl); } catch { throw validationError(`URL ссылки ${index + 1} указан неверно.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw validationError(`URL ссылки ${index + 1} должен быть HTTP или HTTPS адресом без данных входа.`);
    }
    return { title, url: url.toString() };
  });
}
function normalizeChannelAssetPath(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw validationError(`${label} должен быть путём к файлу.`);
  const rawPath = value.trim();
  if (!rawPath || rawPath.length > 4_096 || rawPath.includes('\0')) {
    throw validationError(`${label} указан неверно.`);
  }
  const filePath = path.resolve(rawPath);
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error('not-a-file');
  } catch {
    throw validationError(`${label} не найден по указанному пути.`);
  }
  return filePath;
}
function summarizeChannelBatchTasks(batchTasks) {
  const summary = { total: batchTasks.length, queued: 0, running: 0, completed: 0, manualLoginRequired: 0, error: 0, cancelled: 0 };
  for (const task of batchTasks) {
    if (task.status === 'queued') summary.queued += 1;
    else if (['starting-profile', 'applying'].includes(task.status)) summary.running += 1;
    else if (task.status === 'completed') summary.completed += 1;
    else if (task.status === 'manual-login-required') summary.manualLoginRequired += 1;
    else if (task.status === 'cancelled') summary.cancelled += 1;
    else if (task.status === 'error') summary.error += 1;
  }
  return summary;
}
function publicChannelBatch(batchId, batchTasks) {
  const summary = summarizeChannelBatchTasks(batchTasks);
  const createdAt = batchTasks.reduce((earliest, task) => !earliest || String(task.createdAt || '') < earliest ? String(task.createdAt || '') : earliest, '');
  const updatedAt = batchTasks.reduce((latest, task) => String(task.updatedAt || task.createdAt || '') > latest ? String(task.updatedAt || task.createdAt || '') : latest, '');
  return {
    id: batchId,
    source: 'bulk-channel',
    createdAt,
    updatedAt,
    autoRun: batchTasks.some(task => task.autoRun === true),
    ...summary,
  };
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
          processAccountCheckBatches().catch(error => addLog(`Ошибка очереди проверки аккаунтов: ${error.message}`, null, 'error'));
          processScheduledChannelTasks().catch(error => addLog(`Ошибка очереди оформления каналов: ${error.message}`, null, 'error'));
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
  processAccountCheckBatches().catch(error => addLog(`Ошибка очереди проверки аккаунтов: ${error.message}`, null, 'error'));
  processScheduledChannelTasks().catch(error => addLog(`Ошибка очереди оформления каналов: ${error.message}`, null, 'error'));
  processProcessingBatches().catch(error => addLog(`Ошибка очереди обработки файлов: ${error.message}`, null, 'error'));
}, 5000);
scheduler.unref();
const manualSessionJanitor = setInterval(() => { expireManualSessions().catch(error => addLog(`Ошибка очистки ручных сессий: ${error.message}`, null, 'error')); }, 60_000);
manualSessionJanitor.unref();

app.use(express.json());
// The control panel is deliberately local-only.  Serving the project root
// would also expose local library files and implementation sources, so expose
// only the two browser assets the UI needs.
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(root, 'index.html'));
});
app.get('/client.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.sendFile(path.join(root, 'client.js'));
});

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
    const rows = responseRows(result);
    res.json({ data: rows.map(publicProfile), total: Number(result?.total ?? result?.meta?.total ?? rows.length) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/folders', async (_req, res) => {
  try {
    const result = await dolphinClient.listFolders();
    const rows = responseRows(result);
    res.json({ data: rows.map(publicFolder), total: Number(result?.total ?? result?.meta?.total ?? rows.length) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/folders', async (req, res) => {
  let payload;
  try {
    payload = normalizeFolderInput(req.body);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  try {
    const result = await dolphinClient.createFolder(payload);
    const folder = publicFolder({ ...payload, ...dolphinEntity(result) });
    addLog(`Создана папка Dolphin: ${folder.name}`);
    res.status(201).json({ folder });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/profiles/create', async (req, res) => {
  let input;
  try {
    input = normalizeProfileCreationInput(req.body);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  try {
    // The fingerprint is fetched immediately before creation and passed through unchanged.
    const fingerprintResponse = await dolphinClient.fingerprint({
      platform: input.platform,
      browserType: 'anty',
      browserVersion: input.browserVersion,
    });
    const fingerprint = fingerprintFromResponse(fingerprintResponse);
    if (!Object.keys(fingerprint).length) {
      return res.status(422).json({ error: 'Dolphin API не вернул подходящий отпечаток для выбранной платформы и версии браузера.' });
    }
    const payload = {
      name: input.name,
      platform: input.platform,
      browserType: 'anty',
      platformVersion: input.platformVersion,
      tags: input.tags,
      fingerprint,
      ...(input.folderId === null ? {} : { folderId: input.folderId }),
    };
    const result = await dolphinClient.createProfile(payload);
    const created = dolphinEntity(result);
    const id = created.id ?? result?.browserProfileId ?? result?.id;
    if (id === undefined || id === null || String(id).trim() === '') {
      throw new Error('Dolphin API не вернул идентификатор созданного профиля.');
    }
    const profile = publicProfile({
      ...created,
      id,
      name: created.name ?? payload.name,
      platform: created.platform ?? payload.platform,
      browserType: created.browserType ?? payload.browserType,
      folderId: created.folderId ?? payload.folderId ?? null,
      tags: Array.isArray(created.tags) ? created.tags : payload.tags,
    });
    addLog(`Создан профиль Dolphin: ${profile.name}`);
    res.status(201).json({ profile, browserVersion: input.browserVersion });
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
  const cachedEditorUrl = cleanAccountUrl(accountStatusCache[String(profileId)]?.url);
  const inspected = wsEndpoint ? await inspectChannel({ wsEndpoint, channelUrl: cachedEditorUrl }) : { status: 'automation-unavailable' };
  const channel = cacheAccountStatus(profileId, inspected);
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

const MAX_ACCOUNT_CHECK_BATCH_SIZE = 100;
function normalizeAccountCheckProfileIds(rawIds) {
  if (!Array.isArray(rawIds)) return { error: 'profileIds должен быть массивом.' };
  if (rawIds.length > MAX_ACCOUNT_CHECK_BATCH_SIZE) return { error: `За одну проверку можно передать не более ${MAX_ACCOUNT_CHECK_BATCH_SIZE} профилей.` };
  const profileIds = [];
  const seen = new Set();
  const invalidPositions = [];
  rawIds.forEach((value, index) => {
    if (typeof value !== 'string' && typeof value !== 'number') {
      invalidPositions.push(index + 1);
      return;
    }
    const profileId = String(value).trim();
    if (!profileId || profileId.length > 128 || /[\u0000-\u001f\u007f\s]/.test(profileId)) {
      invalidPositions.push(index + 1);
      return;
    }
    if (!seen.has(profileId)) {
      seen.add(profileId);
      profileIds.push(profileId);
    }
  });
  if (invalidPositions.length) return { error: `profileIds содержит недопустимые значения в позициях: ${invalidPositions.join(', ')}.` };
  if (!profileIds.length) return { error: 'Выберите хотя бы один профиль Dolphin.' };
  if (profileIds.length > MAX_ACCOUNT_CHECK_BATCH_SIZE) return { error: `За одну проверку можно добавить не более ${MAX_ACCOUNT_CHECK_BATCH_SIZE} профилей.` };
  return { profileIds };
}
function summarizeAccountCheckBatch(batch) {
  const counts = (batch.items || []).reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    total: batch.items?.length || 0,
    queued: counts.queued || 0,
    running: counts.running || 0,
    completed: counts.completed || 0,
    failed: counts.error || 0,
    manualLoginRequired: counts['manual-login-required'] || 0,
  };
}
function refreshAccountCheckBatchStatus(batch) {
  const summary = summarizeAccountCheckBatch(batch);
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
function publicAccountCheckBatch(batch) {
  const summary = summarizeAccountCheckBatch(batch);
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    status: batch.status,
    ...summary,
    items: (batch.items || []).map(item => ({
      profileId: String(item.profileId),
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      checkedAt: item.checkedAt || null,
      message: cleanAccountText(item.message, 240),
    })),
  };
}
async function runAccountCheckBatchItem(batch, item) {
  item.status = 'running';
  item.message = 'Проверяем доступ к YouTube Studio.';
  item.updatedAt = new Date().toISOString();
  refreshAccountCheckBatchStatus(batch);
  saveState();
  try {
    const result = await readProfileChannel(item.profileId);
    item.checkedAt = result.channel.checkedAt;
    if (result.channel.status === 'manual-login-required') {
      item.status = 'manual-login-required';
      item.message = 'В этом профиле нужно завершить ручной вход в YouTube.';
    } else {
      item.status = 'completed';
      item.message = result.channel.status === 'connected'
        ? 'Канал доступен в YouTube Studio.'
        : 'Статус профиля считан.';
    }
  } catch {
    // Store only a generic failure state.  The cache must not become a place
    // for local API responses, browser details, or credential-like data.
    const failedAccount = cacheAccountStatus(item.profileId, { status: 'error' });
    item.checkedAt = failedAccount?.checkedAt || new Date().toISOString();
    item.status = 'error';
    item.message = 'Проверка профиля не выполнена.';
    addLog(`Не удалось проверить YouTube-профиль ${item.profileId}`, null, 'error');
  }
  item.updatedAt = new Date().toISOString();
  refreshAccountCheckBatchStatus(batch);
  saveState();
}
async function processAccountCheckBatches() {
  if (accountCheckBatchPumpRunning) return;
  accountCheckBatchPumpRunning = true;
  try {
    let changed = false;
    for (const batch of accountCheckBatches) {
      if (!['queued', 'running'].includes(batch.status)) continue;
      for (const item of batch.items || []) {
        if (item.status !== 'queued') continue;
        if (workerOccupiedProfiles().size >= settings.maxConcurrentTasks) return;
        const operation = queueProfileOperation({
          key: `account-check:${batch.id}:${item.profileId}`,
          profileId: item.profileId,
          work: () => runAccountCheckBatchItem(batch, item),
        });
        if (operation.started) {
          operation.promise
            .catch(() => addLog(`Не удалось завершить проверку YouTube-профиля ${item.profileId}`, null, 'error'))
            .finally(() => {
              if (backgroundEnabled) processAccountCheckBatches().catch(error => addLog(`Ошибка очереди проверки аккаунтов: ${error.message}`, null, 'error'));
            });
        } else if (operation.code === 'workers-busy') {
          return;
        }
      }
      const before = batch.status;
      refreshAccountCheckBatchStatus(batch);
      changed = changed || before !== batch.status;
    }
    if (changed) saveState();
  } finally {
    accountCheckBatchPumpRunning = false;
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
    // A failed read is represented by a generic cache state only; no error
    // payload from Dolphin or YouTube is persisted in the account cache.
    try { cacheAccountStatus(req.params.id, { status: 'error' }); } catch {}
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
      processAccountCheckBatches().catch(error => addLog(`Ошибка очереди проверки аккаунтов: ${error.message}`, null, 'error'));
      processScheduledChannelTasks().catch(error => addLog(`Ошибка очереди оформления каналов: ${error.message}`, null, 'error'));
    }
  }
  res.json({ settings: { ...settings }, worker: workerState() });
});
app.get('/api/studio-videos', (req, res) => {
  const profileId = String(req.query.profileId || '');
  const record = studioCache[profileId];
  res.json(record || { profileId, syncedAt: null, videos: [], total: 0 });
});
app.get('/api/accounts', (_req, res) => {
  const accounts = Object.entries(accountStatusCache)
    .map(([profileId, account]) => publicAccount(profileId, account))
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));
  res.json({ accounts, total: accounts.length });
});
app.get('/api/accounts/check-batches', (_req, res) => {
  res.json({ batches: accountCheckBatches.slice(0, 20).map(publicAccountCheckBatch) });
});
app.post('/api/accounts/check-batches', (req, res) => {
  const normalized = normalizeAccountCheckProfileIds(req.body?.profileIds);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const now = new Date().toISOString();
  const batch = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    items: normalized.profileIds.map(profileId => ({
      profileId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      message: 'Ожидает свободный поток.',
    })),
  };
  accountCheckBatches.unshift(batch);
  if (accountCheckBatches.length > 20) accountCheckBatches.splice(20);
  refreshAccountCheckBatchStatus(batch);
  saveState();
  if (backgroundEnabled) processAccountCheckBatches().catch(error => addLog(`Ошибка запуска пакетной проверки аккаунтов: ${error.message}`, null, 'error'));
  res.status(202).json({ batch: publicAccountCheckBatch(batch), worker: workerState() });
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
app.get('/api/channels/batches', (_req, res) => {
  const grouped = new Map();
  for (const task of channelTasks) {
    if (task?.source !== 'bulk-channel' || !task?.batchId) continue;
    const batchId = String(task.batchId);
    const items = grouped.get(batchId) || [];
    items.push(task);
    grouped.set(batchId, items);
  }
  const batches = [...grouped.entries()]
    .map(([batchId, items]) => publicChannelBatch(batchId, items))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
  res.json({ batches: batches.slice(0, 50) });
});
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

app.post('/api/library/upload', async (req, res) => {
  const originalName = safeFileName(req.query.name || req.headers['x-file-name']);
  if (!isOctetStreamRequest(req)) {
    drainUploadRequest(req);
    return res.status(400).json({ error: 'Файл не получен.' });
  }
  const extension = path.extname(originalName).toLowerCase();
  if (!libraryUploadExtensions.has(extension)) {
    drainUploadRequest(req);
    return res.status(415).json({ error: 'Поддерживаются видеофайлы MP4, MOV, MKV, WebM, AVI и M4V.' });
  }
  const targetPath = path.join(libraryDir, `${crypto.randomUUID()}-${originalName}`);
  const tempPath = `${targetPath}.uploading`;
  let finalized = false;
  let libraryItem = null;
  let uploadError = null;
  try {
    await streamLibraryUpload(req, tempPath);
    const inspected = await inspectMediaFile(tempPath, { ffprobeBin });
    // Both files are in the library directory, so the rename is atomic. A
    // completed entry is never visible under its final name before ffprobe
    // has accepted the streamed upload.
    await fs.promises.rename(tempPath, targetPath);
    finalized = true;
    const metadata = { ...inspected, filePath: targetPath, fileName: path.basename(targetPath) };
    libraryItem = makeLibraryEntry(metadata, 'uploaded');
    library.unshift(libraryItem);
    saveState();
    addLog(`Файл скопирован в библиотеку: ${libraryItem.fileName}`);
  } catch (error) {
    if (libraryItem) {
      const index = library.findIndex(item => item.id === libraryItem.id);
      if (index >= 0) library.splice(index, 1);
    }
    uploadError = error;
  } finally {
    // Clean up a partially written file, failed validation, failed rename, or
    // a final file whose state entry could not be committed.
    if (!finalized || libraryItem === null) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    }
  }
  if (uploadError) {
    const statusCode = Number.isInteger(uploadError?.statusCode) ? uploadError.statusCode : 422;
    return res.status(statusCode).json({ error: uploadError.message });
  }
  return res.status(201).json({ item: libraryItem });
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
  if (rejectTaskState(res, task, ['queued'], 'Запуск')) return;
  if (task.manualSessionOpen) return res.status(409).json({ error: 'Для открытой ручной сессии используйте «Проверить вход».', code: 'manual-session-open', worker: workerState() });
  const operation = queueUploadTask(task);
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(publicTask(task));
});

app.post('/api/tasks/:id/upload', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (rejectTaskState(res, task, ['profile-ready'], 'Загрузка')) return;
  if (task.manualSessionOpen) return res.status(409).json({ error: 'Для открытой ручной сессии используйте «Проверить вход».', code: 'manual-session-open', worker: workerState() });
  const operation = queueUploadTask(task, { uploadOnly: true });
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(publicTask(task));
});

app.post('/api/tasks/:id/prepare-login', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (task.manualSessionOpen) return res.status(409).json({ error: 'Сессия ручного входа уже открыта. Завершите вход и нажмите «Проверить вход».', code: 'manual-session-open', worker: workerState() });
  if (rejectTaskState(res, task, ['queued', 'profile-ready', 'manual-login-required', 'login-ready'], 'Открытие входа')) return;
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
  if (rejectTaskState(res, task, ['manual-login-required', 'login-ready'], 'Проверка входа')) return;
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

app.post('/api/tasks/bulk', (req, res) => {
  const profileResult = normalizeBulkProfileIds(req.body?.profileIds);
  if (profileResult.error) return res.status(400).json({ error: profileResult.error });
  const videoResult = validateBulkVideoPath(req.body?.videoPath);
  if (videoResult.error) return res.status(400).json({ error: videoResult.error });

  const titleTemplate = typeof req.body?.titleTemplate === 'string' ? req.body.titleTemplate.trim() : '';
  if (!titleTemplate) return res.status(400).json({ error: 'titleTemplate is required.' });
  const description = req.body?.description === undefined ? '' : req.body.description;
  if (typeof description !== 'string' || description.length > 5000) {
    return res.status(400).json({ error: 'description must be a string no longer than 5000 characters.' });
  }
  const rawTags = req.body?.tags === undefined ? [] : req.body.tags;
  if (!Array.isArray(rawTags) || rawTags.some(tag => typeof tag !== 'string')) {
    return res.status(400).json({ error: 'tags must be an array of strings.' });
  }
  const tags = rawTags.map(tag => tag.trim()).filter(Boolean);
  const rawScheduledAt = req.body?.scheduledAt;
  const autoUpload = req.body?.autoUpload === true;
  let scheduledAt = null;
  if (rawScheduledAt !== undefined && rawScheduledAt !== null && rawScheduledAt !== '') {
    if (typeof rawScheduledAt !== 'string' || !Number.isFinite(Date.parse(rawScheduledAt))) {
      return res.status(400).json({ error: 'scheduledAt must be an ISO date string when provided.' });
    }
    scheduledAt = new Date(rawScheduledAt).toISOString();
  }

  const titles = profileResult.profileIds.map((profileId, index) => ({
    profileId,
    title: fillBulkTitleTemplate(titleTemplate, profileId, index + 1).trim(),
  }));
  const invalidTitle = titles.find(item => !item.title || item.title.length > 100);
  if (invalidTitle) {
    return res.status(400).json({ error: `titleTemplate produced an invalid title for profile ${invalidTitle.profileId}. Titles must be 1-100 characters.` });
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const created = titles.map(({ profileId, title }) => ({
    id: crypto.randomUUID(),
    profileId,
    videoPath: videoResult.videoPath,
    title,
    description,
    tags,
    scheduledAt,
    autoUpload,
    source: 'bulk-queue',
    batchId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }));

  try {
    tasks.push(...created);
    saveState();
  } catch (error) {
    tasks.splice(tasks.length - created.length, created.length);
    return res.status(500).json({ error: `Bulk queue was not saved: ${error.message}` });
  }
  addLog(`Created ${created.length} queued upload task(s) in bulk batch ${batchId}.`);
  if (backgroundEnabled && autoUpload) {
    queueMicrotask(() => processScheduledTasks().catch(error => addLog(`Ошибка автоматического запуска пакетной очереди: ${error.message}`, batchId, 'error')));
  }
  res.status(201).json({
    batchId,
    created: created.length,
    profileIds: profileResult.profileIds,
    autoUpload,
    manualStartRequired: !autoUpload,
    tasks: created.map(publicTask),
  });
});

app.post('/api/tasks', (req, res) => {
  const { profileId, videoPath, title, description = '', tags = [], scheduledAt = null, autoUpload = true } = req.body || {};
  const profileResult = normalizeBulkProfileIds([profileId]);
  if (profileResult.error) return res.status(400).json({ error: 'Выберите корректный профиль Dolphin.' });
  const videoResult = validateBulkVideoPath(videoPath);
  if (videoResult.error) return res.status(400).json({ error: 'Укажите существующий файл ролика.' });
  const safeTitle = typeof title === 'string' ? title.trim() : '';
  if (!safeTitle || safeTitle.length > 100) return res.status(400).json({ error: 'Заголовок должен содержать от 1 до 100 символов.' });
  if (typeof description !== 'string' || description.length > 5000) return res.status(400).json({ error: 'Описание должно быть строкой до 5000 символов.' });
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) return res.status(400).json({ error: 'Теги должны быть списком строк.' });
  let safeScheduledAt = null;
  if (scheduledAt) {
    if (typeof scheduledAt !== 'string' || !Number.isFinite(Date.parse(scheduledAt))) return res.status(400).json({ error: 'Время запуска указано неверно.' });
    safeScheduledAt = new Date(scheduledAt).toISOString();
  }
  const task = {
    id: crypto.randomUUID(), profileId: profileResult.profileIds[0], videoPath: videoResult.videoPath,
    title: safeTitle, description, tags: tags.map(tag => tag.trim()).filter(Boolean), scheduledAt: safeScheduledAt,
    autoUpload: Boolean(autoUpload), source: 'single', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveState();
  if (backgroundEnabled && task.autoUpload) queueMicrotask(() => processScheduledTasks().catch(error => addLog(`Ошибка автоматического запуска: ${error.message}`, task.id, 'error')));
  res.status(201).json(publicTask(task));
});

app.post('/api/tasks/:id/cancel', async (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (rejectTaskState(res, task, ['queued', 'scheduled', 'profile-ready', 'manual-login-required', 'login-ready', 'recovery-needed'], 'Отмена')) return;
  if (activeOperationForTask(task.id)) {
    return res.status(409).json({ error: 'Задача сейчас выполняется. Дождитесь завершения операции, затем отмените её.', code: 'task-busy', worker: workerState() });
  }
  await releaseManualSession(task);
  task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
  saveState();
  res.json(publicTask(task));
});

app.post('/api/channels/tasks/bulk', (req, res) => {
  const profileResult = normalizeBulkProfileIds(req.body?.profileIds);
  if (profileResult.error) return res.status(400).json({ error: profileResult.error });
  if (profileResult.profileIds.length > MAX_BULK_CHANNEL_TASKS) {
    return res.status(400).json({ error: `За один пакет можно добавить не более ${MAX_BULK_CHANNEL_TASKS} профилей.` });
  }

  let nameTemplate;
  let descriptionTemplate;
  let links;
  let avatarPath;
  let bannerPath;
  try {
    nameTemplate = normalizeChannelTemplate(req.body?.name, 'Название канала', 100);
    descriptionTemplate = normalizeChannelTemplate(req.body?.description, 'Описание канала', 5_000);
    links = normalizeChannelLinks(req.body?.links);
    avatarPath = normalizeChannelAssetPath(req.body?.avatarPath, 'Аватар канала');
    bannerPath = normalizeChannelAssetPath(req.body?.bannerPath, 'Баннер канала');
  } catch (error) {
    return res.status(error?.statusCode || 400).json({ error: error.message });
  }
  if (!nameTemplate && !descriptionTemplate && !links.length && !avatarPath && !bannerPath) {
    return res.status(400).json({ error: 'Укажите хотя бы одно изменение оформления канала.' });
  }
  if (req.body?.autoRun !== undefined && typeof req.body.autoRun !== 'boolean') {
    return res.status(400).json({ error: 'autoRun должен быть логическим значением.' });
  }
  const autoRun = req.body?.autoRun === true;

  const expanded = [];
  for (const [offset, profileId] of profileResult.profileIds.entries()) {
    const index = offset + 1;
    const name = fillBulkTitleTemplate(nameTemplate, profileId, index).trim();
    const description = fillBulkTitleTemplate(descriptionTemplate, profileId, index).trim();
    if (name.length > 100 || hasUnsafeTextControl(name)) {
      return res.status(400).json({ error: `Название для профиля ${profileId} превышает лимит или содержит недопустимые символы.` });
    }
    if (description.length > 5_000 || hasUnsafeTextControl(description)) {
      return res.status(400).json({ error: `Описание для профиля ${profileId} превышает лимит или содержит недопустимые символы.` });
    }
    if (!name && !description && !links.length && !avatarPath && !bannerPath) {
      return res.status(400).json({ error: `Для профиля ${profileId} не осталось изменений оформления.` });
    }
    expanded.push({ profileId, name, description });
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const created = expanded.map(({ profileId, name, description }) => ({
    id: crypto.randomUUID(),
    profileId,
    name,
    description,
    links: links.map(link => ({ ...link })),
    avatarPath,
    bannerPath,
    autoRun,
    source: 'bulk-channel',
    batchId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }));

  try {
    channelTasks.unshift(...created);
    saveState();
  } catch (error) {
    channelTasks.splice(0, created.length);
    return res.status(500).json({ error: `Пакет оформления не сохранён: ${error.message}` });
  }
  addLog(`Создан пакет оформления каналов: ${created.length} профилей.`, batchId);
  if (backgroundEnabled && autoRun) {
    queueMicrotask(() => processScheduledChannelTasks().catch(error => addLog(`Ошибка автоматического запуска оформления: ${error.message}`, batchId, 'error')));
  }
  res.status(201).json({
    batchId,
    created: created.length,
    profileIds: profileResult.profileIds,
    autoRun,
    manualStartRequired: !autoRun,
    tasks: created,
    batch: publicChannelBatch(batchId, created),
    worker: workerState(),
  });
});

app.post('/api/channels/tasks', (req, res) => {
  const profileResult = normalizeBulkProfileIds([req.body?.profileId]);
  if (profileResult.error) return res.status(400).json({ error: profileResult.error });
  let name;
  let description;
  let links;
  let avatarPath;
  let bannerPath;
  try {
    name = normalizeChannelTemplate(req.body?.name, 'Название канала', 100);
    description = normalizeChannelTemplate(req.body?.description, 'Описание канала', 5_000);
    links = normalizeChannelLinks(req.body?.links);
    avatarPath = normalizeChannelAssetPath(req.body?.avatarPath, 'Аватар канала');
    bannerPath = normalizeChannelAssetPath(req.body?.bannerPath, 'Баннер канала');
  } catch (error) {
    return res.status(error?.statusCode || 400).json({ error: error.message });
  }
  if (!name && !description && !links.length && !avatarPath && !bannerPath) {
    return res.status(400).json({ error: 'Укажите хотя бы одно изменение оформления канала.' });
  }
  const task = {
    id: crypto.randomUUID(), profileId: profileResult.profileIds[0], name, description, links,
    avatarPath, bannerPath, source: 'single', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  try {
    channelTasks.unshift(task);
    saveState();
  } catch (error) {
    channelTasks.shift();
    return res.status(500).json({ error: `Задача оформления не сохранена: ${error.message}` });
  }
  addLog(`Задача оформления канала создана для профиля ${task.profileId}`, task.id);
  res.status(201).json(task);
});

async function runChannelTask(task) {
  task.status = 'starting-profile'; task.error = ''; task.updatedAt = new Date().toISOString(); saveState();
  try {
    const profileResult = await startDolphinForAutomation(task.profileId);
    const wsEndpoint = getAutomationEndpoint(profileResult);
    if (!wsEndpoint) { task.status = 'manual-login-required'; task.message = 'Профиль открыт. Выполните ручной вход в YouTube, затем запустите задачу повторно.'; }
    else {
      task.status = 'applying'; saveState();
      task.result = await updateChannelBranding({ wsEndpoint, name: task.name, description: task.description, links: task.links, avatarPath: task.avatarPath, bannerPath: task.bannerPath });
      if (task.result.status === 'applied' && task.result.saveConfirmed !== true) {
        throw new Error('YouTube Studio did not independently confirm saving the channel changes.');
      }
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

async function processScheduledChannelTasks() {
  if (channelTaskPumpRunning) return;
  channelTaskPumpRunning = true;
  try {
    const dueTasks = channelTasks
      .filter(task => task.status === 'queued' && task.autoRun === true)
      .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0));
    for (const task of dueTasks) {
      if (workerOccupiedProfiles().size >= settings.maxConcurrentTasks) break;
      const operation = queueChannelTask(task);
      if (operation.started) {
        operation.promise.catch(error => addLog(`Ошибка пакетного оформления канала: ${error.message}`, task.id, 'error'));
      }
    }
  } finally {
    channelTaskPumpRunning = false;
  }
}

app.post('/api/channels/tasks/:id/run', async (req, res) => {
  const task = channelTasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Задача оформления канала не найдена' });
  if (!['queued', 'error', 'recovery-needed', 'manual-login-required'].includes(task.status)) {
    return res.status(409).json({ error: 'Эту задачу нельзя запустить в текущем статусе.', task });
  }
  const operation = queueChannelTask(task);
  if (!operation.started) return res.status(409).json({ error: operation.message, code: operation.code, worker: workerState() });
  await operation.promise;
  res.json(task);
});

app.get('/api/processing/batches', (_req, res) => {
  res.json({
    batches: processingBatches
      .slice(0, MAX_PROCESSING_BATCHES)
      .map(publicProcessingBatch),
    processor: {
      active: activeProcessingJobIds.size,
      limit: MAX_PROCESSING_CONCURRENCY,
    },
  });
});

app.post('/api/processing/batches', async (req, res) => {
  const rawJobs = req.body?.jobs;
  if (!Array.isArray(rawJobs) || !rawJobs.length) {
    return res.status(400).json({ error: 'Добавьте хотя бы одну пару «исходник — выходной файл».', code: 'processing-empty' });
  }
  if (rawJobs.length > MAX_PROCESSING_BATCH_SIZE) {
    return res.status(400).json({ error: `За один пакет доступно не более ${MAX_PROCESSING_BATCH_SIZE} исходных файлов.`, code: 'processing-too-large' });
  }
  const requestedConcurrency = req.body?.concurrency === undefined ? 1 : Number(req.body.concurrency);
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > MAX_PROCESSING_CONCURRENCY) {
    return res.status(400).json({ error: `Для локальной обработки выберите от 1 до ${MAX_PROCESSING_CONCURRENCY} потоков.`, code: 'processing-invalid-concurrency' });
  }
  try {
    const seenInputs = new Set();
    const seenOutputs = new Set();
    const items = [];
    for (let index = 0; index < rawJobs.length; index += 1) {
      items.push(await normalizeProcessingJob(rawJobs[index], index, seenInputs, seenOutputs));
    }
    const now = new Date().toISOString();
    const batch = {
      id: crypto.randomUUID(),
      source: 'own-media-batch',
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      concurrency: requestedConcurrency,
      autoRun: req.body?.autoRun !== false,
      items,
    };
    processingBatches.unshift(batch);
    if (processingBatches.length > MAX_PROCESSING_BATCHES) processingBatches.splice(MAX_PROCESSING_BATCHES);
    refreshProcessingBatchStatus(batch);
    saveState();
    addLog(`Создан пакет локальной обработки: ${items.length} собственных исходников.`, null, 'info');
    if (backgroundEnabled && batch.autoRun) {
      processProcessingBatches().catch(error => addLog(`Ошибка запуска пакетной обработки: ${error.message}`, null, 'error'));
    }
    return res.status(201).json({ batch: publicProcessingBatch(batch), processor: { active: activeProcessingJobIds.size, limit: MAX_PROCESSING_CONCURRENCY } });
  } catch (error) {
    return res.status(error.statusCode || 422).json({ error: error.message, code: error.code || 'processing-validation-failed' });
  }
});

app.post('/api/processing/batches/:id/run', async (req, res) => {
  const batch = processingBatches.find(item => item.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Пакет обработки не найден.' });
  if (batch.status === 'completed') return res.status(409).json({ error: 'Этот пакет уже завершён.', code: 'processing-completed' });
  try {
    if (req.body?.retryFailed === true) {
      const retryItems = (batch.items || []).filter(item => ['error', 'recovery-needed'].includes(item.status));
      retryItems.forEach(assertProcessingRetryable);
      retryItems.forEach(item => queueProcessingRetry(batch, item));
    }
    const hasQueued = (batch.items || []).some(item => item.status === 'queued');
    if (!hasQueued) {
      return res.status(409).json({ error: 'В пакете нет задач, готовых к запуску. Для повторной попытки включите повтор задач с ошибками.', code: 'processing-no-queued-items' });
    }
    batch.autoRun = true;
    batch.updatedAt = new Date().toISOString();
    refreshProcessingBatchStatus(batch);
    saveState();
    if (backgroundEnabled) processProcessingBatches().catch(error => addLog(`Ошибка очереди обработки файлов: ${error.message}`, null, 'error'));
    return res.status(202).json({ batch: publicProcessingBatch(batch), processor: { active: activeProcessingJobIds.size, limit: MAX_PROCESSING_CONCURRENCY } });
  } catch (error) {
    return res.status(error.statusCode || 422).json({ error: error.message, code: error.code || 'processing-retry-failed' });
  }
});

app.post('/api/processing/batches/:batchId/items/:itemId/retry', async (req, res) => {
  const batch = processingBatches.find(item => item.id === req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Пакет обработки не найден.' });
  const item = (batch.items || []).find(candidate => candidate.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Задача обработки не найдена.' });
  try {
    queueProcessingRetry(batch, item);
    batch.autoRun = true;
    if (backgroundEnabled) processProcessingBatches().catch(error => addLog(`Ошибка очереди обработки файлов: ${error.message}`, null, 'error'));
    return res.status(202).json({ batch: publicProcessingBatch(batch), item: publicProcessingBatch({ ...batch, items: [item] }).items[0] });
  } catch (error) {
    return res.status(error.statusCode || 422).json({ error: error.message, code: error.code || 'processing-retry-failed' });
  }
});

app.get('/api/campaigns', (_req, res) => {
  syncMediaCampaignProgress();
  res.json({
    campaigns: mediaCampaigns.slice(0, MAX_MEDIA_CAMPAIGNS).map(publicMediaCampaign),
    processor: { active: activeProcessingJobIds.size, limit: MAX_PROCESSING_CONCURRENCY },
  });
});

app.get('/api/campaigns/:id', (req, res) => {
  syncMediaCampaignProgress();
  const campaign = mediaCampaigns.find(item => item.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена.', code: 'campaign-not-found' });
  return res.json({ campaign: publicMediaCampaign(campaign) });
});

app.post('/api/campaigns', (req, res) => {
  let staged;
  try {
    staged = createMediaCampaign(req.body || {});
  } catch (error) {
    return res.status(error.statusCode || 422).json({ error: error.message, code: error.code || 'campaign-validation-failed' });
  }
  try {
    mediaCampaigns.unshift(staged.campaign);
    processingBatches.unshift(...staged.batches);
    saveState();
  } catch (error) {
    const campaignIndex = mediaCampaigns.indexOf(staged.campaign);
    if (campaignIndex >= 0) mediaCampaigns.splice(campaignIndex, 1);
    for (const batch of staged.batches) {
      const index = processingBatches.indexOf(batch);
      if (index >= 0) processingBatches.splice(index, 1);
    }
    return res.status(500).json({ error: `Campaign was not saved: ${error.message}`, code: 'campaign-save-failed' });
  }
  addLog(`Создана кампания локальной обработки: ${staged.campaign.outputCount} результатов.`, null, 'info');
  if (staged.campaign.autoRun) {
    for (const batch of staged.batches) batch.autoRun = true;
    staged.campaign.updatedAt = new Date().toISOString();
    saveState();
    if (backgroundEnabled) {
      queueMicrotask(() => processProcessingBatches().catch(error => addLog(`Ошибка запуска кампании: ${error.message}`, staged.campaign.id, 'error')));
    }
  }
  return res.status(201).json({ campaign: publicMediaCampaign(staged.campaign), processor: { active: activeProcessingJobIds.size, limit: MAX_PROCESSING_CONCURRENCY } });
});

app.post('/api/campaigns/:id/run', async (req, res) => {
  const campaign = mediaCampaigns.find(item => item.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена.', code: 'campaign-not-found' });
  if (['completed', 'ready-for-upload', 'awaiting-review'].includes(campaign.status)) {
    return res.status(409).json({ error: 'В кампании нет новых локальных задач для запуска.', code: 'campaign-no-queued-items', campaign: publicMediaCampaign(campaign) });
  }
  try {
    const retryFailed = req.body?.retryFailed === true;
    const batches = processingBatches.filter(batch => batch.campaignId === campaign.id);
    if (!batches.length) throw campaignError('У этой кампании не найдены задания обработки.', 409, 'campaign-no-batches');
    for (const batch of batches) {
      if (retryFailed) {
        for (const item of batch.items || []) {
          if (['error', 'recovery-needed'].includes(item.status)) queueProcessingRetry(batch, item);
        }
      }
      if ((batch.items || []).some(item => item.status === 'queued')) batch.autoRun = true;
      refreshProcessingBatchStatus(batch);
    }
    campaign.autoRun = true;
    campaign.updatedAt = new Date().toISOString();
    refreshMediaCampaignStatus(campaign);
    saveState();
    // A deliberate Run command starts local FFmpeg work even if background
    // scheduling was disabled for diagnostics/tests.  It never touches
    // Dolphin or YouTube.
    processProcessingBatches().catch(error => addLog(`Ошибка обработки кампании: ${error.message}`, campaign.id, 'error'));
    return res.status(202).json({ campaign: publicMediaCampaign(campaign), processor: { active: activeProcessingJobIds.size, limit: MAX_PROCESSING_CONCURRENCY } });
  } catch (error) {
    return res.status(error.statusCode || 422).json({ error: error.message, code: error.code || 'campaign-run-failed' });
  }
});

app.get('/api/uniqueizer/presets', (_req, res) => {
  res.json({ presets: listEditorialPresets() });
});

app.get('/api/uniqueizer/health', async (_req, res) => {
  try { const result = await execFileAsync(ffmpegBin, ['-version']); res.json({ available: true, path: ffmpegBin, version: result.stdout.split('\n')[0] }); }
  catch { res.json({ available: false, message: 'FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.' }); }
});

app.post('/api/uniqueizer/render', async (req, res) => {
  const { inputPath, outputPath, overlayPath } = req.body || {};
  if (!inputPath || !outputPath) return res.status(400).json({ error: 'inputPath и outputPath обязательны' });
  let safeInputPath;
  let safeOutputPath;
  let safeOverlayPath = '';
  try {
    safeInputPath = normalizeProcessingPath(inputPath, 'Исходник');
    safeOutputPath = normalizeProcessingPath(outputPath, 'Выходной файл');
    if (!libraryOwnsProcessingInput(safeInputPath)) throw processingError('Исходник нужно сначала добавить в библиотеку Creator Flow.');
    if (safeInputPath === safeOutputPath) throw processingError('Исходник и выходной файл не должны совпадать.');
    if (!processingOutputExtensions.has(path.extname(safeOutputPath).toLowerCase())) throw processingError('Выходной файл должен иметь расширение .mp4.');
    const outputDirectory = fs.statSync(path.dirname(safeOutputPath));
    if (!outputDirectory.isDirectory()) throw processingError('Папка для выходного файла недоступна.');
    if (fs.existsSync(safeOutputPath)) throw processingError('Выходной файл уже существует. Укажите новый путь.', 409, 'processing-output-exists');
    safeOverlayPath = normalizeProcessingOverlay(overlayPath);
    const metadata = await inspectMediaFile(safeInputPath, { ffprobeBin });
    if (!metadata.hasVideo) throw processingError('В исходном файле не найден видеопоток.');
  }
  catch (error) { return res.status(422).json({ status: 'error', error: error.message }); }
  const args = ['-hide_banner', '-nostdin', '-n', '-i', safeInputPath];
  if (safeOverlayPath) args.push('-i', safeOverlayPath, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]', '-map', '[v]', '-map', '0:a?');
  else args.push('-map', '0:v:0', '-map', '0:a?');
  args.push('-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', safeOutputPath);
  try {
    await execFileAsync(ffmpegBin, args, { windowsHide: true });
    const metadata = await inspectMediaFile(safeOutputPath, { ffprobeBin });
    const existing = library.find(item => path.resolve(item.filePath) === path.resolve(metadata.filePath));
    const item = existing || makeLibraryEntry(metadata, 'processed');
    if (!existing) library.unshift(item);
    saveState(); addLog(`Обработка завершена: ${metadata.fileName}`);
    res.status(201).json({ status: 'completed', outputPath: safeOutputPath, item });
  }
  catch (error) { res.status(422).json({ status: 'error', error: error.message, hint: 'Установите FFmpeg и проверьте пути к файлам.' }); }
});

const serverPort = Number(process.env.PORT || 3030);
const serverHost = String(process.env.CREATOR_FLOW_HOST || '127.0.0.1').trim() || '127.0.0.1';
if (backgroundEnabled) {
  queueMicrotask(() => processProcessingBatches().catch(error => addLog(`Ошибка запуска очереди обработки файлов: ${error.message}`, null, 'error')));
}
const server = app.listen(serverPort, serverHost, () => console.log(`Creator Flow: http://${serverHost}:${server.address().port}`));
export { app, server };
