const state = { health: null, profiles: [], tasks: [], library: [], channelTasks: [], logs: [], proxies: [], settings: null, worker: null, accountStates: new Map(), analytics: new Map(), studioBatches: [] };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const pageNames = { overview: 'Главная', profiles: 'Профили Dolphin', accounts: 'Аккаунты YouTube', queue: 'Очередь задач', library: 'Библиотека', channels: 'Каналы', processing: 'Обработка', analytics: 'Аналитика', settings: 'Настройки' };

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Ошибка сервера (${response.status})`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function formatNumber(value) { return Number(value || 0).toLocaleString('ru-RU'); }
function formatSize(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 * 1024 ? 0 : 1)} МБ`;
}
function formatDuration(value) {
  const seconds = Math.round(Number(value || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60); const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
function statusPill(status) {
  const type = /error|cancelled|manual-login-required|recovery-needed/.test(status) ? 'error' : /queued|starting|uploading|awaiting|scheduled/.test(status) ? 'wait' : '';
  return `<span class="pill ${type}">${escapeHtml(status)}</span>`;
}
function setMessage(target, text, type = '') {
  const element = typeof target === 'string' ? $(target) : target;
  if (!element) return;
  element.textContent = text || '';
  element.className = `state-line ${type}`;
}
function profileIdOf(profile) { return String(profile.id || profile.uuid || ''); }
function profileNameOf(profile) { return profile.name || profile.title || profileIdOf(profile); }

function activatePage(id) {
  $$('.nav button').forEach(button => button.classList.toggle('active', button.dataset.page === id));
  $$('.page').forEach(page => page.classList.toggle('active', page.id === id));
  $('#page-title').textContent = pageNames[id] || 'Creator Flow';
  if (id === 'accounts') renderAccounts();
  if (id === 'analytics') Promise.all([refreshAnalyticsView(), loadStudioBatches()]).catch(() => {});
  if (id === 'settings') refreshSettings().catch(() => {});
}

function fillProfileSelect(select, preferred = '') {
  if (!select) return;
  const previous = preferred || select.value;
  select.innerHTML = state.profiles.length
    ? state.profiles.map(profile => `<option value="${escapeHtml(profileIdOf(profile))}">${escapeHtml(profileNameOf(profile))}</option>`).join('')
    : '<option value="">Профили Dolphin не найдены</option>';
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

function fillLibrarySelect(select, includeBlank = true) {
  if (!select) return;
  const previous = select.value;
  const blank = includeBlank ? '<option value="">Выберите файл</option>' : '';
  select.innerHTML = blank + state.library.map(item => `<option value="${escapeHtml(item.filePath)}" data-title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)} · ${formatDuration(item.durationSeconds)}</option>`).join('');
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

async function loadHealth() {
  state.health = await api('/api/health');
  const online = state.health.remoteApi && state.health.localReachable;
  const localLabel = state.health.localReachable
    ? 'локальное приложение отвечает'
    : 'локальное приложение недоступно';
  $('#side-status').textContent = online ? 'Dolphin подключён' : 'Проверьте Dolphin';
  const notice = $('#connection-notice');
  notice.className = `notice ${online ? '' : 'warn'}`;
  notice.textContent = online
    ? 'Creator Flow подключён к локальному Dolphin и его API. Данные страниц загружаются только по вашему действию.'
    : `Статус: ${state.health.remoteApi ? 'API Dolphin доступен, но локальное приложение не отвечает.' : 'API Dolphin недоступен. Проверьте ключ и запущенное приложение Dolphin.'}`;
  $('#settings-health').className = `notice ${online ? '' : 'warn'}`;
  $('#settings-health').textContent = online ? 'Dolphin API и локальное приложение доступны.' : 'Нет полного подключения к Dolphin.';
  $('#settings-automation').textContent = localLabel;
}

async function loadProfiles() {
  const response = await api('/api/profiles');
  state.profiles = response.data || response.profiles || response.items || [];
  ['#task-profile', '#channel-profile', '#analytics-profile'].forEach(selector => fillProfileSelect($(selector)));
  $('#metric-profiles').textContent = formatNumber(state.profiles.length);
  renderProfiles(); renderAccounts();
}

async function loadTasks() {
  const response = await api('/api/tasks');
  state.tasks = response.tasks || [];
  $('#metric-queue').textContent = formatNumber(state.tasks.filter(task => !['cancelled', 'awaiting-review'].includes(task.status)).length);
  renderTasks(); renderOverviewTasks();
}

async function loadLibrary() {
  const response = await api('/api/library');
  state.library = response.library || [];
  fillLibrarySelect($('#task-library')); fillLibrarySelect($('#render-source'), false);
  $('#metric-library').textContent = formatNumber(state.library.length);
  renderLibrary();
}

async function loadChannelTasks() {
  const response = await api('/api/channels/tasks');
  state.channelTasks = response.tasks || [];
  renderChannelTasks();
}

async function loadLogs() {
  const response = await api('/api/logs');
  state.logs = response.logs || [];
  renderLogs();
}

async function loadProxies() {
  const response = await api('/api/proxies');
  state.proxies = response.proxies || [];
  renderProxies();
}

async function loadFfmpeg() {
  const response = await api('/api/uniqueizer/health');
  const element = $('#ffmpeg-status');
  element.className = `notice ${response.available ? '' : 'warn'}`;
  element.textContent = response.available ? `FFmpeg готов: ${response.version || response.path}` : response.message;
  $('#settings-ffmpeg').textContent = response.available ? 'готов' : 'не найден';
}

function renderWorkerSettings() {
  const select = $('#settings-concurrency');
  if (!select || !state.settings) return;
  const value = String(state.settings.maxConcurrentTasks || 5);
  if (![...select.options].some(option => option.value === value)) {
    select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(value)} потоков</option>`);
  }
  select.value = value;
  const worker = state.worker || { active: 0, limit: value, lockedProfiles: 0 };
  setMessage(
    '#settings-worker',
    `Глобальная очередь: занято ${worker.active} из ${worker.limit} слотов. Параллельно выполняются задачи только на разных профилях; на одном профиле — не более одной операции. Ручных сессий: ${worker.lockedProfiles}.`,
  );
}

async function loadWorkerSettings() {
  const response = await api('/api/settings');
  state.settings = response.settings || null;
  state.worker = response.worker || null;
  renderWorkerSettings();
}

async function refreshAll() {
  $('#refresh-all').disabled = true;
  try {
    await loadHealth();
    await Promise.all([loadProfiles(), loadTasks(), loadLibrary(), loadChannelTasks(), loadLogs(), loadProxies(), loadFfmpeg(), loadWorkerSettings(), loadStudioBatches()]);
    await refreshAnalyticsView();
  } catch (error) {
    const notice = $('#connection-notice'); notice.className = 'notice error'; notice.textContent = error.message;
  } finally { $('#refresh-all').disabled = false; }
}

function renderProfiles() {
  const target = $('#profiles-list');
  if (!state.profiles.length) { target.innerHTML = '<div class="empty">Dolphin не вернул профили. Проверьте API-ключ и подключение.</div>'; return; }
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile); const name = profileNameOf(profile);
    return `<div class="profile-card"><div><b>${escapeHtml(name)}</b><div class="meta">ID: ${escapeHtml(id)} · ${escapeHtml(profile.platform || 'browser profile')}</div></div><div class="profile-actions"><button class="btn" data-profile-start="${escapeHtml(id)}">Запустить</button><button class="btn" data-profile-stop="${escapeHtml(id)}">Остановить</button><button class="btn primary" data-profile-channel="${escapeHtml(id)}">YouTube</button></div></div>`;
  }).join('');
  target.querySelectorAll('[data-profile-start]').forEach(button => button.onclick = () => controlProfile(button.dataset.profileStart, 'start', button));
  target.querySelectorAll('[data-profile-stop]').forEach(button => button.onclick = () => controlProfile(button.dataset.profileStop, 'stop', button));
  target.querySelectorAll('[data-profile-channel]').forEach(button => button.onclick = () => { fillProfileSelect($('#channel-profile'), button.dataset.profileChannel); activatePage('channels'); });
}

function renderAccounts() {
  const target = $('#accounts-list');
  if (!target) return;
  if (!state.profiles.length) {
    target.innerHTML = '<div class="empty">Профили Dolphin не найдены. Сначала обновите подключение к Dolphin.</div>';
    return;
  }
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile);
    const account = state.accountStates.get(id);
    const status = account?.status === 'connected'
      ? `Подключён: ${escapeHtml(account.channelName || 'канал прочитан')}`
      : account?.status === 'manual-login-required'
        ? 'Требуется ручной вход в YouTube'
        : account?.error || 'Статус ещё не проверен';
    const className = account?.status === 'connected' ? 'pill' : account?.status === 'manual-login-required' || account?.error ? 'pill error' : 'pill wait';
    return `<div class="profile-card"><div><b>${escapeHtml(profileNameOf(profile))}</b><div class="meta">${escapeHtml(status)}</div></div><div class="profile-actions"><span class="${className}">${escapeHtml(account?.status || 'не проверен')}</span><button class="btn primary" data-account-check="${escapeHtml(id)}">Проверить YouTube</button></div></div>`;
  }).join('');
  target.querySelectorAll('[data-account-check]').forEach(button => button.onclick = () => checkAccount(button.dataset.accountCheck, button));
}

async function checkAccount(id, button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = 'Проверка…';
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(id)}/youtube-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.accountStates.set(id, { ...result.channel, channelName: result.channel?.channelName || '' });
    await loadLogs();
  } catch (error) {
    state.accountStates.set(id, { status: 'error', error: error.message });
  } finally {
    renderAccounts();
    const replacement = $('#accounts-list').querySelector(`[data-account-check="${CSS.escape(id)}"]`);
    if (replacement) { replacement.disabled = false; replacement.textContent = oldText; }
  }
}

async function controlProfile(id, action, button) {
  const oldText = button.textContent; button.disabled = true; button.textContent = '…';
  try { await api(`/api/profiles/${encodeURIComponent(id)}/${action}`, { method: 'POST' }); await loadLogs(); button.textContent = action === 'start' ? 'Запущен' : 'Остановлен'; }
  catch (error) { button.textContent = error.message; }
  finally { setTimeout(() => { button.disabled = false; button.textContent = oldText; }, 1500); }
}

function renderTask(task) {
  const actions = [];
  if (task.status === 'queued') actions.push(`<button class="btn" data-task-action="run" data-task-id="${escapeHtml(task.id)}">Запустить</button>`);
  if (task.status === 'profile-ready') actions.push(`<button class="btn primary" data-task-action="upload" data-task-id="${escapeHtml(task.id)}">Загрузить</button>`);
  if (task.status === 'manual-login-required') {
    actions.push(task.manualSessionOpen
      ? `<button class="btn primary" data-task-action="continue-upload" data-task-id="${escapeHtml(task.id)}">Проверить вход</button>`
      : `<button class="btn warning" data-task-action="prepare-login" data-task-id="${escapeHtml(task.id)}">Открыть вход</button>`);
  }
  if (task.status === 'login-ready') actions.push(`<button class="btn primary" data-task-action="continue-upload" data-task-id="${escapeHtml(task.id)}">Продолжить</button>`);
  if (!['cancelled', 'awaiting-review', 'error'].includes(task.status)) actions.push(`<button class="btn danger" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}">Отменить</button>`);
  return `<div class="task"><span class="number">▸</span><span><b>${escapeHtml(task.title)}</b><br><small>${escapeHtml(task.profileId)} · ${task.scheduledAt ? `запуск ${formatDate(task.scheduledAt)}` : 'ручной запуск'}${task.message ? ` · ${escapeHtml(task.message)}` : ''}</small></span><div>${statusPill(task.status)}<div class="profile-actions" style="margin-top:7px">${actions.join('')}</div></div></div>`;
}

function renderTasks() {
  const target = $('#queue-list');
  target.innerHTML = state.tasks.length ? state.tasks.map(renderTask).join('') : '<div class="empty">Очередь пуста. Добавьте свой ролик и назначьте профиль Dolphin.</div>';
  target.querySelectorAll('[data-task-action]').forEach(button => button.onclick = () => taskAction(button.dataset.taskId, button.dataset.taskAction, button));
}

function renderOverviewTasks() {
  const target = $('#overview-tasks');
  const active = state.tasks.filter(task => task.status !== 'cancelled').slice(0, 6);
  target.innerHTML = active.length ? active.map(renderTask).join('') : '<div class="empty">Нет задач. Перейдите в «Очередь», чтобы добавить первую.</div>';
  target.querySelectorAll('[data-task-action]').forEach(button => button.onclick = () => taskAction(button.dataset.taskId, button.dataset.taskAction, button));
}

async function taskAction(id, action, button) {
  button.disabled = true; const oldText = button.textContent; button.textContent = '…';
  try {
    const endpoint = action === 'run'
      ? `/api/tasks/${id}/run`
      : action === 'upload'
        ? `/api/tasks/${id}/upload`
        : action === 'prepare-login'
          ? `/api/tasks/${id}/prepare-login`
          : action === 'continue-upload'
            ? `/api/tasks/${id}/upload/continue`
            : `/api/tasks/${id}/cancel`;
    await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await Promise.all([loadTasks(), loadLogs()]);
  } catch (error) { button.textContent = error.message; button.disabled = false; setTimeout(() => { button.textContent = oldText; }, 2500); }
}

function renderLibrary() {
  const target = $('#library-list');
  target.innerHTML = state.library.length ? state.library.map(item => `<div class="list-row"><div><b>${escapeHtml(item.fileName)}</b><div class="file-meta"><span>${formatSize(item.sizeBytes)}</span><span>${formatDuration(item.durationSeconds)}</span><span>${item.video.width && item.video.height ? `${item.video.width}×${item.video.height}` : 'видео не найдено'}</span></div><div class="meta">${escapeHtml(item.filePath)}</div></div><button class="btn danger" data-library-remove="${escapeHtml(item.id)}">Убрать из списка</button></div>`).join('') : '<div class="empty">Библиотека пуста.</div>';
  target.querySelectorAll('[data-library-remove]').forEach(button => button.onclick = () => removeLibraryItem(button.dataset.libraryRemove));
}

async function removeLibraryItem(id) {
  await api(`/api/library/${id}`, { method: 'DELETE' });
  await Promise.all([loadLibrary(), loadLogs()]);
}

function renderChannelTasks() {
  const target = $('#channel-tasks');
  target.innerHTML = state.channelTasks.length ? state.channelTasks.map(task => `<div class="task"><span class="number">✎</span><span><b>${escapeHtml(task.name || 'Изменение оформления')}</b><br><small>${escapeHtml(task.profileId)} · ${escapeHtml(task.status)}${task.message ? ` · ${escapeHtml(task.message)}` : ''}</small></span><div>${statusPill(task.status)} ${task.status === 'completed' ? '' : `<button class="btn primary" data-channel-task="${escapeHtml(task.id)}">Применить</button>`}</div></div>`).join('') : '<div class="empty">Задач оформления пока нет.</div>';
  target.querySelectorAll('[data-channel-task]').forEach(button => button.onclick = () => runChannelTask(button.dataset.channelTask, button));
}

async function runChannelTask(id, button) {
  button.disabled = true; button.textContent = '…';
  try { await api(`/api/channels/tasks/${id}/run`, { method: 'POST' }); await Promise.all([loadChannelTasks(), loadLogs()]); }
  catch (error) { button.textContent = error.message; button.disabled = false; }
}

function renderLogs() {
  const build = logs => logs.length ? logs.map(log => `<div class="${escapeHtml(log.level)}">${formatDate(log.timestamp)} · ${escapeHtml(log.message)}</div>`).join('') : '<span class="hint">Операций пока нет.</span>';
  $('#overview-logs').innerHTML = build(state.logs.slice(0, 12));
  $('#operations-log').innerHTML = build(state.logs);
}

function renderProxies() {
  const target = $('#proxy-list');
  target.innerHTML = state.proxies.length ? state.proxies.slice(0, 30).map(proxy => `<div class="list-row"><div><b>${escapeHtml(proxy.host)}:${escapeHtml(proxy.port)}</b><div class="meta">${escapeHtml(proxy.type || 'http')} · ${escapeHtml(proxy.username || 'без логина')} · ${escapeHtml(proxy.status || 'не проверен')}</div></div></div>`).join('') : '<div class="empty">Прокси не импортированы.</div>';
}

function getAnalyticsRecord(profileId) { return state.analytics.get(profileId) || { profileId, videos: [], total: 0, syncedAt: null }; }

async function refreshAnalyticsView() {
  const select = $('#analytics-profile');
  if (!select || !select.value) { renderAnalytics({ profileId: '', videos: [], total: 0, syncedAt: null }); return; }
  try {
    const record = await api(`/api/studio-videos?profileId=${encodeURIComponent(select.value)}`);
    state.analytics.set(select.value, record); renderAnalytics(record);
  } catch (error) { setMessage('#analytics-message', error.message, 'error'); }
}

function renderAnalytics(record) {
  const videos = record.videos || [];
  const parsedViews = videos.map(video => video.viewsNumber).filter(value => Number.isFinite(value));
  $('#analytics-total').textContent = formatNumber(videos.length);
  $('#analytics-views').textContent = parsedViews.length ? formatNumber(parsedViews.reduce((sum, value) => sum + value, 0)) : '—';
  $('#analytics-sync-date').textContent = record.syncedAt ? formatDate(record.syncedAt) : '—';
  $('#analytics-source').textContent = record.syncedAt ? 'YouTube Studio' : 'нет данных';
  $('#metric-synced').textContent = formatNumber(videos.length);
  const target = $('#analytics-list');
  target.innerHTML = videos.length ? videos.map(video => `<div class="analytics-row"><div><b>${escapeHtml(video.title)}</b><div class="small">${escapeHtml(video.status || 'статус не прочитан')} · ${escapeHtml(video.date || 'дата не прочитана')}</div></div><div class="right">${escapeHtml(video.views || '—')}<div class="small">просмотры</div></div><div class="small right">${video.url ? `<a href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">Открыть</a>` : 'ссылка не найдена'}</div></div>`).join('') : '<div class="empty">Нет синхронизированных данных. Выберите профиль и нажмите «Синхронизировать».</div>';
}

function batchSummary(batch) {
  const items = batch.items || [];
  const total = Number(batch.total ?? items.length);
  const completed = Number(batch.completed ?? items.filter(item => item.status === 'completed').length);
  const failed = Number(batch.failed ?? items.filter(item => item.status === 'error').length);
  const running = Number(batch.running ?? items.filter(item => item.status === 'running').length);
  const queued = Number(batch.queued ?? Math.max(0, total - completed - failed - running));
  return { total, completed, failed, running, queued };
}

function renderStudioBatches() {
  const target = $('#analytics-batches');
  if (!target) return;
  if (!state.studioBatches.length) {
    target.innerHTML = '<div class="empty">Пакетных синхронизаций пока нет.</div>';
    return;
  }
  target.innerHTML = state.studioBatches.slice(0, 8).map(batch => {
    const summary = batchSummary(batch);
    const details = (batch.items || []).filter(item => item.status === 'error').slice(0, 3)
      .map(item => `${escapeHtml(item.profileId)}: ${escapeHtml(item.error || 'ошибка')}`).join('<br>');
    return `<div class="list-row"><div><b>Пакет ${escapeHtml(String(batch.id).slice(0, 8))}</b><div class="meta">${formatDate(batch.createdAt)} · ${escapeHtml(batch.status || 'queued')}</div>${details ? `<div class="small error">${details}</div>` : ''}</div><div class="right"><b>${summary.completed}/${summary.total}</b><div class="small">готово · ${summary.running} в работе · ${summary.queued} в очереди${summary.failed ? ` · ${summary.failed} ошибок` : ''}</div></div></div>`;
  }).join('');
}

async function loadStudioBatches() {
  const response = await api('/api/studio/sync-batches');
  state.studioBatches = response.batches || [];
  renderStudioBatches();
}

async function syncAllAnalytics() {
  if (!state.profiles.length) return setMessage('#analytics-message', 'Нет профилей Dolphin для пакетной синхронизации.', 'error');
  const button = $('#analytics-sync-all');
  button.disabled = true;
  button.textContent = 'Создание пакета…';
  try {
    const response = await api('/api/studio/sync-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: state.profiles.map(profileIdOf) }),
    });
    await Promise.all([loadStudioBatches(), loadLogs(), loadWorkerSettings()]);
    setMessage('#analytics-message', `Пакет создан: ${response.batch?.total || state.profiles.length} профилей поставлены в очередь.`, '');
  } catch (error) {
    setMessage('#analytics-message', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Синхронизировать все';
  }
}

async function syncAnalytics(restart = false) {
  const profileId = $('#analytics-profile').value;
  if (!profileId) return setMessage('#analytics-message', 'Выберите профиль Dolphin.', 'error');
  const button = $('#analytics-sync'); button.disabled = true; button.textContent = restart ? 'Перезапуск…' : 'Синхронизация…';
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(profileId)}/videos/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restart }) });
    if (result.status === 'manual-login-required') { setMessage('#analytics-message', 'В этом профиле требуется ручной вход в YouTube.', 'error'); renderAnalytics(result); return; }
    state.analytics.set(profileId, result); renderAnalytics(result); setMessage('#analytics-message', `Считано роликов: ${result.total}.`, ''); await loadLogs();
  } catch (error) {
    setMessage('#analytics-message', error.message, 'error');
    if (error.code === 'profile-already-running') appendRestartButton('#analytics-message', () => syncAnalytics(true), 'Перезапустить и синхронизировать');
  } finally { button.disabled = false; button.textContent = 'Синхронизировать'; }
}

function appendRestartButton(target, action, label) {
  const element = typeof target === 'string' ? $(target) : target;
  const button = document.createElement('button'); button.className = 'btn warning'; button.style.marginTop = '8px'; button.textContent = label; button.onclick = action; element.after(button);
}

async function refreshSettings() { await Promise.all([loadHealth(), loadLogs(), loadProxies(), loadFfmpeg(), loadWorkerSettings()]); }

function bindEvents() {
  $$('.nav button').forEach(button => button.onclick = () => activatePage(button.dataset.page));
  $('#refresh-all').onclick = refreshAll;
  $('#go-queue').onclick = () => activatePage('queue');
  $('#profiles-refresh').onclick = () => loadProfiles().catch(error => alert(error.message));
  $('#accounts-refresh').onclick = () => loadProfiles().catch(error => alert(error.message));
  $('#task-library').onchange = event => {
    const selected = state.library.find(item => item.filePath === event.target.value);
    if (!selected) return;
    $('#task-video-path').value = selected.filePath;
    if (!$('#task-title').value) $('#task-title').value = selected.fileName.replace(/\.[^.]+$/, '');
  };
  $('#task-form').onsubmit = async event => {
    event.preventDefault();
    const scheduledValue = $('#task-scheduled').value;
    const body = { profileId: $('#task-profile').value, videoPath: $('#task-video-path').value.trim(), title: $('#task-title').value.trim(), description: $('#task-description').value.trim(), tags: $('#task-tags').value.split(',').map(tag => tag.trim()).filter(Boolean), scheduledAt: scheduledValue ? new Date(scheduledValue).toISOString() : null, autoUpload: $('#task-auto-upload').checked };
    try { await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); event.target.reset(); fillProfileSelect($('#task-profile')); fillLibrarySelect($('#task-library')); setMessage('#task-form-message', 'Задача добавлена в очередь.'); await Promise.all([loadTasks(), loadLogs()]); }
    catch (error) { setMessage('#task-form-message', error.message, 'error'); }
  };
  $('#library-upload').onclick = uploadLibraryFiles;
  $('#library-import-path').onclick = importLibraryPath;
  $('#channel-read').onclick = () => readChannel(false);
  $('#channel-form').onsubmit = createChannelTask;
  $('#render-form').onsubmit = renderVideo;
  $('#analytics-profile').onchange = refreshAnalyticsView;
  $('#analytics-sync').onclick = () => syncAnalytics(false);
  $('#analytics-sync-all').onclick = syncAllAnalytics;
  $('#proxy-import').onclick = importProxies;
  $('#settings-save-concurrency').onclick = saveWorkerSettings;
}

async function saveWorkerSettings() {
  const button = $('#settings-save-concurrency');
  const previousSettings = state.settings ? { ...state.settings } : null;
  const previousWorker = state.worker ? { ...state.worker } : null;
  button.disabled = true;
  try {
    const response = await api('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrentTasks: Number($('#settings-concurrency').value) }),
    });
    state.settings = response.settings;
    state.worker = response.worker;
    renderWorkerSettings();
  } catch (error) {
    // Restore the last confirmed values immediately, then ask the server for
    // its current state. This prevents a rejected selection from remaining in
    // the control and looking as if it had been saved.
    state.settings = previousSettings;
    state.worker = previousWorker;
    renderWorkerSettings();
    try {
      await loadWorkerSettings();
      setMessage('#settings-worker', `Не удалось сохранить настройку: ${error.message}. Показано текущее значение сервера.`, 'error');
    } catch (refreshError) {
      setMessage('#settings-worker', `Не удалось сохранить настройку: ${error.message}. Показано последнее подтверждённое значение.`, 'error');
    }
  } finally {
    button.disabled = false;
  }
}

async function uploadLibraryFiles() {
  const files = [...$('#library-files').files];
  if (!files.length) return setMessage('#library-message', 'Выберите хотя бы один видеофайл.', 'error');
  const button = $('#library-upload'); button.disabled = true;
  try {
    for (const file of files) {
      setMessage('#library-message', `Копирование: ${file.name}`);
      await api(`/api/library/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    }
    $('#library-files').value = ''; setMessage('#library-message', `Добавлено файлов: ${files.length}.`); await Promise.all([loadLibrary(), loadLogs()]);
  } catch (error) { setMessage('#library-message', error.message, 'error'); }
  finally { button.disabled = false; }
}

async function importLibraryPath() {
  const filePath = $('#library-path').value.trim();
  if (!filePath) return setMessage('#library-message', 'Укажите полный путь к видеофайлу.', 'error');
  try { const result = await api('/api/library/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath }) }); $('#library-path').value = ''; setMessage('#library-message', result.existing ? 'Этот файл уже есть в библиотеке.' : 'Файл добавлен в библиотеку.'); await Promise.all([loadLibrary(), loadLogs()]); }
  catch (error) { setMessage('#library-message', error.message, 'error'); }
}

async function readChannel(restart = false) {
  const profileId = $('#channel-profile').value; const target = $('#channel-identity');
  target.textContent = restart ? 'Перезапуск профиля и чтение YouTube Studio…' : 'Чтение состояния YouTube Studio…';
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(profileId)}/youtube-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restart }) });
    const channel = result.channel;
    target.textContent = channel.status === 'connected' ? `Подключён канал: ${channel.channelName || 'название не прочитано'} · ${channel.url}` : channel.status === 'manual-login-required' ? 'В этом профиле требуется ручной вход в YouTube.' : 'Dolphin не выдал адрес Automation API.';
    await loadLogs();
  } catch (error) {
    target.textContent = error.message;
    if (error.code === 'profile-already-running') appendRestartButton(target, () => readChannel(true), 'Перезапустить и считать');
  }
}

async function createChannelTask(event) {
  event.preventDefault();
  const links = $('#channel-links').value.split(/\r?\n/).map(line => line.split('|').map(part => part.trim())).filter(parts => parts[0] && parts[1]).map(([title, url]) => ({ title, url }));
  const body = { profileId: $('#channel-profile').value, name: $('#channel-name').value.trim(), description: $('#channel-description').value.trim(), avatarPath: $('#channel-avatar').value.trim(), bannerPath: $('#channel-banner').value.trim(), links };
  try { await api('/api/channels/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); event.target.reset(); fillProfileSelect($('#channel-profile')); await Promise.all([loadChannelTasks(), loadLogs()]); }
  catch (error) { $('#channel-identity').textContent = error.message; }
}

async function renderVideo(event) {
  event.preventDefault();
  const source = $('#render-source').value;
  const outputPath = $('#render-output').value.trim();
  const overlayPath = $('#render-overlay').value.trim();
  if (!source || !outputPath) return setMessage('#render-message', 'Выберите исходник и укажите путь к результату.', 'error');
  setMessage('#render-message', 'Запущена локальная обработка…');
  try { const response = await api('/api/uniqueizer/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputPath: source, outputPath, overlayPath }) }); setMessage('#render-message', `Готово: ${response.outputPath}`); await Promise.all([loadLibrary(), loadLogs()]); }
  catch (error) { setMessage('#render-message', error.message, 'error'); }
}

async function importProxies() {
  const text = $('#proxy-text').value.trim();
  if (!text) return setMessage('#proxy-message', 'Вставьте список прокси.', 'error');
  try { const result = await api('/api/proxies/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, type: $('#proxy-type').value }) }); $('#proxy-text').value = ''; setMessage('#proxy-message', `Импортировано: ${result.imported}; ошибочных строк: ${result.invalid}.`); await Promise.all([loadProxies(), loadLogs()]); }
  catch (error) { setMessage('#proxy-message', error.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await refreshAll();
  setInterval(() => loadLogs().catch(() => {}), 12_000);
});
