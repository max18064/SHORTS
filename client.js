const state = {
  health: null, profiles: [], tasks: [], library: [], channelTasks: [], logs: [], proxies: [],
  settings: null, worker: null, accountStates: new Map(), analytics: new Map(), studioBatches: [], accountBatches: [],
  bulkProfileIds: new Set(), channelBulkProfileIds: new Set(), campaignProfileIds: new Set(), folders: [], processingBatches: [], processingProcessor: null,
  campaigns: [], campaignApiAvailable: null,
};

// Presets are transparent starting points for local editorial processing. They
// only populate controls that are rendered in the UI and never synthesize
// device identities or hidden platform-facing metadata.
const UNIQUEIZER_PRESETS = Object.freeze({
  manual: Object.freeze({
    id: 'manual',
    title: 'Ручной рецепт',
    description: 'Все параметры остаются под вашим контролем. Ничего не меняется, пока вы сами не зададите значения.',
    values: Object.freeze({}),
  }),
  'shorts-balanced': Object.freeze({
    id: 'shorts-balanced',
    title: 'Сбалансированный Shorts',
    description: 'Базовый рецепт для вертикального формата: центральное кадрирование, 30 FPS, умеренный диапазон скорости и мягкая цветокоррекция.',
    values: Object.freeze({
      outputCount: 10, layout: 'vertical-9x16', crop: 'smart', speedMin: 0.98, speedMax: 1.02,
      fps: '30', bitrateKbps: 8000, overlayOpacity: 88, overlayBlurMin: 0, overlayBlurMax: 4,
      textSize: 70, textY: 65, textColorMode: 'random-visible', textOutline: true,
      colorCorrectionEnabled: true, colorStrength: 35, audioMode: 'original', metadataPresetId: 'clean',
    }),
  }),
  'soft-editorial': Object.freeze({
    id: 'soft-editorial',
    title: 'Мягкий редакторский',
    description: 'Вертикальный формат без агрессивного кадрирования, небольшой диапазон скорости, нормализация звука и деликатная цветокоррекция.',
    values: Object.freeze({
      outputCount: 10, layout: 'vertical-9x16', crop: 'fit', speedMin: 0.99, speedMax: 1.01,
      fps: '30', bitrateKbps: 7500, overlayOpacity: 72, overlayBlurMin: 1, overlayBlurMax: 5,
      textSize: 64, textY: 68, textColorMode: 'white', textOutline: true,
      colorCorrectionEnabled: true, colorStrength: 25, audioMode: 'normalize', metadataPresetId: 'clean',
    }),
  }),
  'square-stories': Object.freeze({
    id: 'square-stories',
    title: 'Квадратные истории',
    description: 'Рецепт для квадратного 1:1: центральный кадр, 30 FPS, лёгкая цветокоррекция и сохранение исходного звука.',
    values: Object.freeze({
      outputCount: 10, layout: 'square-1x1', crop: 'smart', speedMin: 0.98, speedMax: 1.02,
      fps: '30', bitrateKbps: 7000, overlayOpacity: 82, overlayBlurMin: 0, overlayBlurMax: 3,
      textSize: 60, textY: 64, textColorMode: 'accent', textOutline: true,
      colorCorrectionEnabled: true, colorStrength: 30, audioMode: 'original', metadataPresetId: 'clean',
    }),
  }),
});

const UNIQUEIZER_PRESET_CONTROL_MAP = Object.freeze({
  outputCount: '#campaign-output-count',
  layout: '#campaign-layout',
  crop: '#campaign-crop',
  speedMin: '#campaign-speed-min',
  speedMax: '#campaign-speed-max',
  fps: '#campaign-fps',
  bitrateKbps: '#campaign-bitrate-kbps',
  overlayOpacity: '#campaign-overlay-opacity',
  overlayBlurMin: '#campaign-overlay-blur-min',
  overlayBlurMax: '#campaign-overlay-blur-max',
  textSize: '#campaign-text-size',
  textY: '#campaign-text-y',
  textColorMode: '#campaign-text-color-mode',
  textOutline: '#campaign-text-outline',
  colorCorrectionEnabled: '#campaign-color-correction-enabled',
  colorStrength: '#campaign-color-strength',
  audioMode: '#campaign-audio-mode',
  metadataPresetId: '#campaign-metadata-preset',
});

const EXPORT_METADATA_PRESETS = Object.freeze({
  clean: Object.freeze({
    id: 'clean',
    title: 'Очистить экспортные поля',
    description: 'Очищает технические поля при переэкспорте. Устройство, даты съёмки и идентификаторы не задаются и не изменяются.',
    summary: 'очистка полей',
  }),
  'source-title': Object.freeze({
    id: 'source-title',
    title: 'Название исходника',
    description: 'Использует только название исходного ролика в заголовке экспорта. Устройство, даты съёмки и идентификаторы не изменяются.',
    summary: 'название исходника',
  }),
  'project-export': Object.freeze({
    id: 'project-export',
    title: 'Проектный экспорт',
    description: 'Добавляет в экспортные поля название кампании и номер версии. Устройство, даты съёмки и идентификаторы не изменяются.',
    summary: 'кампания и номер версии',
  }),
});
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const pageNames = { overview: 'Главная', profiles: 'Профили Dolphin', accounts: 'Аккаунты YouTube', campaign: 'Уникализатор', queue: 'Очередь задач', library: 'Библиотека', channels: 'Каналы', processing: 'Обработка', analytics: 'Аналитика', settings: 'Настройки' };

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
function statusPill(status, label = status) {
  const type = /error|cancelled|manual-login-required|recovery-needed/.test(status) ? 'error' : /queued|starting|uploading|awaiting|scheduled/.test(status) ? 'wait' : '';
  return `<span class="pill ${type}">${escapeHtml(label)}</span>`;
}
function setMessage(target, text, type = '') {
  const element = typeof target === 'string' ? $(target) : target;
  if (!element) return;
  element.textContent = text || '';
  element.className = `state-line ${type}`;
}
function profileIdOf(profile) { return String(profile.id || profile.uuid || ''); }
function profileNameOf(profile) { return profile.name || profile.title || profileIdOf(profile); }

function accountPresentation(profile) {
  const account = state.accountStates.get(profileIdOf(profile));
  if (account?.status === 'connected') return { tone: 'ok', label: 'YouTube подключён', badge: 'подключён', account };
  if (account?.status === 'manual-login-required') return { tone: 'warn', label: 'Нужен ручной вход в YouTube', badge: 'вход нужен', account };
  if (account?.status === 'error' || account?.error) return { tone: 'bad', label: account.error || 'Ошибка проверки', badge: 'проверить', account };
  return { tone: 'neutral', label: 'Статус YouTube ещё не проверен', badge: 'не проверен', account };
}

function profileInitials(profile) {
  const words = profileNameOf(profile).trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map(word => word[0]).join('') || 'P').toUpperCase();
}

function profileTags(profile) {
  const values = [profile.platform || profile.browserType, profile.folder?.name || profile.folder]
    .filter(value => typeof value === 'string' && value.trim())
    .slice(0, 2);
  return values.map((value, index) => `<span class="meta-tag ${index === 0 ? 'accent' : ''}">${escapeHtml(value)}</span>`).join('');
}

function workerSnapshot() {
  return state.worker || { active: 0, limit: state.settings?.maxConcurrentTasks || 5, lockedProfiles: 0 };
}

function renderWorkspaceStatus() {
  let target = $('#overview-workflow');
  if (!target && $('#connection-notice')) {
    target = document.createElement('div');
    target.id = 'overview-workflow';
    target.className = 'workspace-strip';
    target.setAttribute('aria-live', 'polite');
    $('#connection-notice').after(target);
  }
  if (!target) return;
  const worker = workerSnapshot();
  const checked = [...state.accountStates.values()];
  const connected = checked.filter(item => item?.status === 'connected').length;
  const activeTasks = state.tasks.filter(task => !['cancelled', 'awaiting-review', 'error'].includes(task.status)).length;
  const online = Boolean(state.health?.remoteApi && state.health?.localReachable);
  const automationConfirmed = Boolean(state.health?.localAuthorized);
  const steps = [
    { mark: '01', label: 'Dolphin', value: online ? `${state.profiles.length} профилей` : 'нет связи', tone: !online ? 'is-offline' : automationConfirmed ? '' : 'is-attention' },
    { mark: '02', label: 'YouTube Studio', value: checked.length ? `${connected}/${checked.length} подключено` : 'ещё не проверено', tone: checked.some(item => item?.status === 'manual-login-required' || item?.status === 'error') ? 'is-attention' : '' },
    { mark: '03', label: 'Очередь', value: activeTasks ? `${activeTasks} активных задач` : 'задач нет', tone: activeTasks ? '' : '' },
    { mark: '04', label: 'Потоки', value: `${worker.active || 0} из ${worker.limit || 0} занято`, tone: worker.active ? 'is-attention' : '' },
  ];
  target.innerHTML = steps.map(step => `<div class="workspace-step ${step.tone}"><span class="step-mark">${step.mark}</span><span><span class="step-label">${step.label}</span><b>${escapeHtml(step.value)}</b></span></div>`).join('');
}

function taskStatusLabel(status) {
  const labels = {
    queued: 'в очереди', scheduled: 'запланирована', starting: 'подготовка профиля', 'starting-profile': 'подготовка профиля', applying: 'применение изменений', 'profile-ready': 'готова к загрузке',
    uploading: 'загрузка в Studio', 'manual-login-required': 'нужен вход', 'login-ready': 'вход подтверждён',
    'awaiting-review': 'на проверке', running: 'обрабатывается', processing: 'обработка версий', preparing: 'подготовка', distributing: 'распределение', prepared: 'подготовлена', 'ready-for-upload': 'в плане загрузки', uploading: 'загрузка в Studio', completed: 'выполнена', cancelled: 'отменена', error: 'ошибка', 'recovery-needed': 'требует проверки', 'needs-attention': 'требует проверки', 'completed-with-errors': 'есть ошибки',
  };
  return labels[status] || status || 'неизвестно';
}

function taskStage(status) {
  const index = ['queued', 'scheduled'].includes(status) ? 0
    : ['starting', 'starting-profile', 'manual-login-required'].includes(status) ? 1
      : ['profile-ready', 'login-ready', 'uploading', 'applying'].includes(status) ? 2 : 3;
  return `<span class="task-stage" aria-label="Этап ${index + 1} из 4">${[0, 1, 2, 3].map(step => `<i class="${step < index ? 'done' : step === index ? 'current' : ''}"></i>`).join('')}</span>`;
}

function activatePage(id) {
  $$('.nav button').forEach(button => button.classList.toggle('active', button.dataset.page === id));
  $$('.page').forEach(page => page.classList.toggle('active', page.id === id));
  $('#page-title').textContent = pageNames[id] || 'Creator Flow';
  if (id === 'accounts') Promise.all([loadAccounts(), loadAccountBatches()]).catch(() => renderAccounts());
  if (id === 'analytics') Promise.all([refreshAnalyticsView(), loadStudioBatches()]).catch(() => {});
  if (id === 'processing') Promise.all([loadProcessingBatches(), loadLibrary()]).catch(() => {});
  if (id === 'campaign') Promise.all([loadCampaigns(), loadLibrary(), loadProfiles(), loadAccounts()]).catch(() => {});
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

function renderProcessingInputPicker() {
  const select = $('#processing-batch-inputs');
  const counter = $('#processing-batch-count');
  if (!select || !counter) return;
  const selected = new Set([...select.selectedOptions].map(option => option.value));
  select.innerHTML = state.library
    .filter(item => item.hasVideo !== false)
    .map(item => `<option value="${escapeHtml(item.filePath)}" ${selected.has(item.filePath) ? 'selected' : ''}>${escapeHtml(item.fileName)} · ${formatDuration(item.durationSeconds)}</option>`)
    .join('');
  const selectedCount = [...select.selectedOptions].length;
  counter.textContent = `Выбрано: ${selectedCount}`;
  select.onchange = () => { counter.textContent = `Выбрано: ${[...select.selectedOptions].length}`; };
}

function videoLibraryItems() {
  return state.library.filter(item => item && item.hasVideo !== false && item.filePath);
}

function campaignNameFromPath(value) {
  return String(value || 'ролик').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'ролик';
}

function updateCampaignPlan() {
  const target = $('#campaign-plan');
  const sourceSelect = $('#campaign-inputs');
  const outputInput = $('#campaign-output-count');
  if (!target || !sourceSelect || !outputInput) return;
  const sourceCount = [...sourceSelect.selectedOptions].length;
  const outputs = Math.max(0, Math.floor(Number(outputInput.value) || 0));
  const distributionEnabled = Boolean($('#campaign-enable-distribution')?.checked);
  const profiles = state.campaignProfileIds.size;
  if (!sourceCount || !outputs) {
    target.innerHTML = 'Выберите исходники и укажите количество готовых роликов, чтобы увидеть план кампании.';
    updateCampaignRecipeSummary();
    return;
  }
  const base = Math.floor(outputs / sourceCount);
  const extra = outputs % sourceCount;
  const distribution = !distributionEnabled
    ? 'Сначала будет выполнена только обработка версий; распределение по каналам не включено.'
    : profiles
    ? `На ${profiles} выбранных профилей будет назначено в среднем ${Math.floor(outputs / profiles)}${outputs % profiles ? '–' + Math.ceil(outputs / profiles) : ''} ролика на профиль.`
    : 'Выберите профили ниже, чтобы задать распределение загрузок.';
  target.innerHTML = `<b>План:</b> ${outputs} готовых роликов из ${sourceCount} источн${sourceCount === 1 ? 'ика' : sourceCount < 5 ? 'иков' : 'иков'}: по ${base}${extra ? `, ещё ${extra} источн${extra === 1 ? 'ик получит' : 'ика получат'} на один результат больше` : ''}.<br>${escapeHtml(distribution)}`;
  updateCampaignRecipeSummary();
}

function renderCampaignSourcePicker() {
  const select = $('#campaign-inputs');
  const counter = $('#campaign-source-count');
  if (!select || !counter) return;
  const previous = new Set([...select.selectedOptions].map(option => option.value));
  const items = videoLibraryItems();
  select.innerHTML = items.map(item => `<option value="${escapeHtml(item.filePath)}" ${previous.has(item.filePath) ? 'selected' : ''}>${escapeHtml(item.fileName)} · ${formatDuration(item.durationSeconds)}</option>`).join('');
  counter.textContent = `Выбрано: ${[...select.selectedOptions].length}`;
  select.onchange = () => {
    counter.textContent = `Выбрано: ${[...select.selectedOptions].length}`;
    updateCampaignPlan();
  };
  updateCampaignPlan();
}

function campaignProfileIsConnected(profile) {
  return state.accountStates.get(profileIdOf(profile))?.status === 'connected';
}

function renderCampaignProfilePicker() {
  const target = $('#campaign-profile-picker');
  const counter = $('#campaign-profile-count');
  if (!target || !counter) return;
  const ids = state.profiles.map(profileIdOf);
  const selected = state.campaignProfileIds;
  counter.textContent = `Выбрано: ${selected.size} из ${ids.length}`;
  if (!ids.length) {
    target.innerHTML = '<div class="empty">Сначала подключите хотя бы один профиль Dolphin.</div>';
    updateCampaignPlan();
    return;
  }
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile);
    const present = accountPresentation(profile);
    const connected = campaignProfileIsConnected(profile);
    return `<label class="bulk-profile-option campaign-profile-option" data-connected="${connected}"><input type="checkbox" value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}><span class="profile-avatar ${present.tone === 'warn' ? 'warning' : present.tone === 'bad' ? 'error' : ''}">${escapeHtml(profileInitials(profile))}</span><span class="bulk-profile-copy"><b>${escapeHtml(profileNameOf(profile))}</b><small>${connected ? 'YouTube подключён' : escapeHtml(present.label)}</small></span></label>`;
  }).join('');
  target.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.onchange = () => {
      if (input.checked) state.campaignProfileIds.add(input.value);
      else state.campaignProfileIds.delete(input.value);
      counter.textContent = `Выбрано: ${state.campaignProfileIds.size} из ${ids.length}`;
      updateCampaignPlan();
    };
  });
  updateCampaignPlan();
}

function setCampaignProfiles(mode) {
  if (mode === 'none') state.campaignProfileIds = new Set();
  else if (mode === 'connected') state.campaignProfileIds = new Set(state.profiles.filter(campaignProfileIsConnected).map(profileIdOf));
  else state.campaignProfileIds = new Set(state.profiles.map(profileIdOf));
  renderCampaignProfilePicker();
}

function setCampaignRecipeTab(tab) {
  $$('[data-campaign-recipe-tab]').forEach(button => button.classList.toggle('active', button.dataset.campaignRecipeTab === tab));
  $$('[data-campaign-recipe-panel]').forEach(panel => { panel.hidden = panel.dataset.campaignRecipePanel !== tab; });
  if (tab === 'progress') renderCampaignProgressPreview();
}

function campaignNumber(selector, fallback = 0) {
  const value = Number($(selector)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function campaignTextVariations() {
  return String($('#campaign-text-variations')?.value || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function currentCampaignPreset() {
  const id = $('#campaign-preset')?.value || 'manual';
  return UNIQUEIZER_PRESETS[id] || UNIQUEIZER_PRESETS.manual;
}

function currentCampaignMetadataPreset() {
  const id = $('#campaign-metadata-preset')?.value || 'clean';
  return EXPORT_METADATA_PRESETS[id] || EXPORT_METADATA_PRESETS.clean;
}

function campaignMetadataLines() {
  return String($('#campaign-metadata-lines')?.value || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function renderCampaignMetadataPreset() {
  const target = $('#campaign-metadata-preset-copy');
  if (!target) return;
  const lines = campaignMetadataLines();
  target.textContent = lines.length
    ? `Строк в списке: ${lines.length}. При создании кампании они будут перемешаны и сохранены за конкретными результатами.`
    : currentCampaignMetadataPreset().description;
}

async function importCampaignMetadataFile(event) {
  const input = event.currentTarget;
  const file = input?.files?.[0];
  if (!file) return;
  if (!/\.(txt|csv)$/i.test(file.name)) {
    input.value = '';
    return setMessage('#campaign-metadata-import-status', 'Выберите TXT или CSV с одной строкой «Название | Комментарий» для каждой версии.', 'error');
  }
  try {
    const text = await file.text();
    const textarea = $('#campaign-metadata-lines');
    if (textarea) textarea.value = text.replace(/\r\n?/g, '\n').trim();
    setMessage('#campaign-metadata-import-status', `Подставлено строк: ${campaignMetadataLines().length}. Файл не отправлялся на сервер.`);
    updateCampaignRecipeSummary();
  } catch (error) {
    setMessage('#campaign-metadata-import-status', `Не удалось прочитать файл: ${error.message}`, 'error');
  } finally {
    input.value = '';
  }
}

function campaignLayoutLabel(layout) {
  return ({ 'vertical-9x16': '9:16', 'square-1x1': '1:1', keep: 'исходный формат' })[layout] || layout;
}

function renderCampaignPreset() {
  const copy = $('#campaign-preset-copy');
  const preview = $('#campaign-preset-preview');
  if (!copy || !preview) return;
  const preset = currentCampaignPreset();
  const metadataPreset = currentCampaignMetadataPreset();
  const recipe = campaignRecipePayload();
  const outputs = Math.max(1, Math.floor(campaignNumber('#campaign-output-count', 1)));
  const metadataSummary = recipe.metadataLines.length
    ? `строки из файла · ${recipe.metadataLines.length}`
    : metadataPreset.summary;
  const labels = [
    `${outputs} результатов`,
    campaignLayoutLabel(recipe.layout),
    `${recipe.speedMin.toFixed(2)}–${recipe.speedMax.toFixed(2)}×`,
    recipe.fps === 'keep' ? 'исходный FPS' : `${recipe.fps} FPS`,
    `${recipe.bitrateKbps} Кбит/с`,
    recipe.colorCorrectionEnabled ? `цветокор ${recipe.colorStrength}%` : 'цветокор выключен',
    `экспорт: ${metadataSummary}`,
    ...(recipe.usePresetOverlay ? ['встроенная цветная PNG‑карточка'] : []),
    ...(recipe.overlayPath ? ['свой PNG подключён'] : recipe.usePresetOverlay ? [] : ['PNG не указан']),
    recipe.textVariations.length ? `текст: ${recipe.textVariations.length} фраз` : 'текст не задан',
  ];
  copy.innerHTML = `<b>${escapeHtml(preset.title)}</b> — ${escapeHtml(preset.description)}`;
  preview.innerHTML = labels.map(label => `<span>${escapeHtml(label)}</span>`).join('');
}

function applyCampaignPreset(id) {
  const preset = UNIQUEIZER_PRESETS[id] || UNIQUEIZER_PRESETS.manual;
  const select = $('#campaign-preset');
  if (select) select.value = preset.id;
  const usePresetOverlay = $('#campaign-use-preset-overlay');
  if (usePresetOverlay) usePresetOverlay.checked = preset.id !== 'manual';
  Object.entries(preset.values).forEach(([key, value]) => {
    const control = $(UNIQUEIZER_PRESET_CONTROL_MAP[key]);
    if (!control) return;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value);
  });
  $$('[data-range-output]').forEach(updateCampaignRangeOutput);
  updateCampaignPlan();
  renderCampaignPreset();
}

function updateCampaignRangeOutput(input) {
  const output = $(`#${input.dataset.rangeOutput}`);
  if (!output) return;
  const suffix = input.id.includes('opacity') || input.id.includes('text-y') || input.id.includes('color-strength') ? '%' : ' px';
  output.textContent = `${input.value}${suffix}`;
}

function syncCampaignProcessingConcurrency(source) {
  const primary = $('#campaign-processing-concurrency');
  const copy = $('#campaign-processing-concurrency-copy');
  if (!primary || !copy) return;
  if (source === 'copy') primary.value = copy.value;
  else copy.value = primary.value;
}

function updateCampaignRecipeSummary() {
  const target = $('#campaign-recipe-summary');
  if (!target) return;
  const recipe = campaignRecipePayload();
  const metadataPreset = currentCampaignMetadataPreset();
  const metadataSummary = recipe.metadataLines.length
    ? `строки из файла · ${recipe.metadataLines.length}`
    : metadataPreset.summary;
  const labels = [];
  if (recipe.usePresetOverlay) labels.push('встроенная цветная PNG‑карточка');
  if (recipe.overlayPath) labels.push(`оверлей · ${recipe.overlayPosition}`);
  if (recipe.textVariations.length) labels.push(`текст · ${recipe.textVariations.length} вариаций`);
  labels.push(`${recipe.layout === 'keep' ? 'исходный формат' : recipe.layout}`);
  labels.push(`${recipe.fps === 'keep' ? 'исходный FPS' : `${recipe.fps} FPS`}`);
  labels.push(`${recipe.bitrateKbps} Кбит/с`);
  if (recipe.colorCorrectionEnabled) labels.push(`цветокор · ${recipe.colorStrength}%`);
  if (recipe.audioMode === 'mute') labels.push('без звука');
  else if (recipe.audioPath) labels.push('фоновая дорожка');
  else if (recipe.audioMode === 'normalize') labels.push('громкость нормализуется');
  labels.push(`экспорт · ${metadataSummary}`);
  target.innerHTML = labels.map(label => `<span>${escapeHtml(label)}</span>`).join('');
  renderCampaignMetadataPreset();
  renderCampaignPreset();
}

function renderCampaignProgressPreview() {
  const target = $('#campaign-progress-preview');
  if (!target) return;
  if (state.campaignApiAvailable === false) {
    target.innerHTML = '<b>Состояние кампаний пока недоступно</b><p>Обновите страницу после запуска локального сервера.</p>';
    return;
  }
  const campaign = state.campaigns[0];
  if (!campaign) {
    target.innerHTML = '<b>Кампаний пока нет</b><p>Создайте кампанию — здесь появится её фактический статус.</p>';
    return;
  }
  const summary = campaignSummary(campaign);
  const total = summary.total || Number(campaign.outputCount || 0);
  const accounted = summary.completed + summary.prepared + summary.awaiting + summary.uploading;
  const percent = total ? Math.min(100, Math.round((accounted / total) * 100)) : 0;
  const name = campaign.name || `Кампания ${String(campaign.id || '').slice(0, 8)}`;
  target.innerHTML = `<b>${escapeHtml(name)}</b><p>${escapeHtml(taskStatusLabel(campaign.status || 'queued'))}: ${formatNumber(accounted)} из ${formatNumber(total)} результатов на следующем этапе.</p><div class="progress"><i style="width:${percent}%"></i></div>`;
}

function updateCampaignDistributionControls() {
  const enabled = Boolean($('#campaign-enable-distribution')?.checked);
  const controls = $('#campaign-distribution-fields');
  const label = $('#campaign-auto-start-label');
  if (controls) controls.disabled = !enabled;
  if (label) label.textContent = enabled
    ? 'Запустить обработку и распределение сразу после создания кампании'
    : 'Запустить обработку сразу после создания кампании';
  updateCampaignPlan();
}

function campaignSummary(campaign) {
  const jobs = campaign.jobs || campaign.items || campaign.assignments || campaign.outputs || campaign.distribution || [];
  const total = Number(campaign.total ?? campaign.outputCount ?? campaign.requestedOutputs ?? jobs.length ?? 0);
  const pick = (...keys) => keys.reduce((result, key) => result + Number(campaign[key] || 0), 0);
  const byStatus = status => jobs.filter(item => String(item.status || '').toLowerCase() === status).length;
  return {
    total,
    processing: Number(campaign.processing ?? campaign.running ?? pick('processingCount') ?? 0) || byStatus('processing'),
    prepared: Number(campaign.prepared ?? campaign.completedProcessing ?? 0) || byStatus('prepared'),
    uploading: Number(campaign.uploading ?? 0) || byStatus('uploading'),
    awaiting: Number(campaign.awaitingReview ?? campaign.awaiting ?? 0) || byStatus('awaiting-review'),
    completed: Number(campaign.completed ?? 0) || byStatus('completed'),
    errors: Number(campaign.failed ?? campaign.errors ?? 0) || byStatus('error'),
    jobs,
  };
}

function campaignItemLabel(item) {
  return item.title || item.outputName || item.outputPath || item.fileName || item.sourceName || campaignNameFromPath(item.sourcePath || item.inputPath || 'ролик');
}

function campaignProfileLabel(item) {
  const profile = state.profiles.find(candidate => profileIdOf(candidate) === String(item.profileId || item.targetProfileId || ''));
  return profile ? profileNameOf(profile) : (item.profileName || item.profileId || item.targetProfileId || 'только обработка');
}

function renderCampaigns(loadError = null) {
  const target = $('#campaign-results');
  if (!target) return;
  if (state.campaignApiAvailable === false) {
    target.innerHTML = `<div class="empty">Экран кампаний готов. Серверная очередь кампаний подключается сейчас${loadError?.message ? `: ${escapeHtml(loadError.message)}` : '.'}</div>`;
    renderCampaignProgressPreview();
    return;
  }
  if (!state.campaigns.length) {
    target.innerHTML = '<div class="empty">Кампаний пока нет. Добавьте исходники, настройте обработку и распределение, затем создайте первую кампанию.</div>';
    renderCampaignProgressPreview();
    return;
  }
  target.innerHTML = state.campaigns.slice(0, 12).map(campaign => {
    const summary = campaignSummary(campaign);
    const id = campaign.id || campaign.campaignId || '';
    const sourceCount = (campaign.sourcePaths || campaign.sources || []).length || campaign.sourceCount || '—';
    const selectedProfiles = (campaign.profileIds || campaign.profiles || []).length || campaign.profileCount || (campaign.distributionEnabled ? '—' : 'не выбраны');
    const status = campaign.status || (summary.completed >= summary.total && summary.total ? 'completed' : summary.processing || summary.uploading ? 'running' : 'queued');
    const canRun = ['queued', 'draft', 'paused', 'error', 'recovery-needed'].includes(status);
    const progress = summary.total ? Math.min(100, Math.round(((summary.completed + summary.awaiting + summary.uploading + summary.prepared) / summary.total) * 100)) : 0;
    const entries = summary.jobs.slice(0, 14).map(item => {
      const itemStatus = item.status || item.stage || 'queued';
      const details = item.message || item.error || item.sourceName || item.sourcePath || '';
      const recipeChanges = Array.isArray(item.recipe?.materialChanges) ? item.recipe.materialChanges.join(', ') : '';
      const exportTitle = item.recipe?.edits?.metadata?.title;
      const exportMetadata = exportTitle
        ? `<span class="meta-tag" title="Экспортный заголовок: ${escapeHtml(exportTitle)}">экспорт: ${escapeHtml(String(exportTitle).slice(0, 72))}</span>`
        : '';
      const duplicate = Number(item.duplicateRenderGroupSize || 1) > 1
        ? `<span class="meta-tag">совпадающий рецепт: ${escapeHtml(item.duplicateRenderGroupSize)}</span>`
        : '';
      return `<div class="campaign-progress-row"><div><b>${escapeHtml(campaignItemLabel(item))}</b><small>${escapeHtml(details)}${recipeChanges ? ` · ${escapeHtml(recipeChanges)}` : ''}</small></div><div><span class="meta-tag accent">${escapeHtml(campaignProfileLabel(item))}</span>${exportMetadata}${duplicate}</div><div class="right">${statusPill(itemStatus, taskStatusLabel(itemStatus))}</div></div>`;
    }).join('') || '<div class="empty">Сервер подготовит здесь распределение роликов по профилям после создания кампании.</div>';
    const duplicateGroups = Array.isArray(campaign.duplicateRenderGroups) ? campaign.duplicateRenderGroups : [];
    const duplicateNotice = duplicateGroups.length
      ? `<div class="notice warn" style="margin-top:12px">В этой кампании есть совпадающие рецепты для ${duplicateGroups.reduce((total, group) => total + (group.outputIndexes?.length || 0), 0)} результатов. Они показаны в строках ниже; такие файлы не следует считать разными версиями только из-за повторного экспорта.</div>`
      : '';
    const uploadSummary = campaign.distributionEnabled
      ? `<span><b>${summary.prepared}</b> в плане загрузки</span><span><b>${summary.awaiting}</b> на проверке</span>`
      : '<span><b>—</b> распределение не включено</span>';
    return `<article class="card campaign-batch"><div class="card-head"><div><h2>${escapeHtml(campaign.name || `Кампания ${String(id).slice(0, 8) || 'без названия'}`)}</h2><p class="hint">${formatDate(campaign.createdAt)} · ${sourceCount} источников · ${selectedProfiles} профилей · ${escapeHtml(campaign.outputCount || campaign.requestedOutputs || summary.total || '—')} результатов</p></div><div class="actions">${statusPill(status, taskStatusLabel(status))}${canRun && id ? `<button class="btn primary" data-campaign-run="${escapeHtml(id)}">Запустить</button>` : ''}</div></div><div class="campaign-summary"><span><b>${summary.completed}</b> выполнено</span><span><b>${summary.processing}</b> обработка</span>${uploadSummary}${summary.errors ? `<span><b>${summary.errors}</b> ошибок</span>` : ''}</div><div class="progress"><i style="width:${progress}%"></i></div>${duplicateNotice}<div class="list" style="margin-top:12px">${entries}</div></article>`;
  }).join('');
  target.querySelectorAll('[data-campaign-run]').forEach(button => button.onclick = () => runCampaign(button.dataset.campaignRun, button));
  renderCampaignProgressPreview();
}

function campaignRecipePayload() {
  return {
    presetId: currentCampaignPreset().id,
    layout: $('#campaign-layout').value,
    crop: $('#campaign-crop').value,
    speedMin: Number($('#campaign-speed-min').value),
    speedMax: Number($('#campaign-speed-max').value),
    overlayPath: $('#campaign-overlay').value.trim(),
    usePresetOverlay: Boolean($('#campaign-use-preset-overlay')?.checked),
    overlayOpacity: campaignNumber('#campaign-overlay-opacity', 100) / 100,
    overlayPosition: $('#campaign-overlay-position').value,
    overlayWidth: campaignNumber('#campaign-overlay-width', 240),
    overlayBlurMin: campaignNumber('#campaign-overlay-blur-min', 0),
    overlayBlurMax: campaignNumber('#campaign-overlay-blur-max', 0),
    textVariations: campaignTextVariations(),
    fontPath: $('#campaign-font-path').value.trim(),
    textSize: campaignNumber('#campaign-text-size', 70),
    textY: campaignNumber('#campaign-text-y', 65),
    textColorMode: $('#campaign-text-color-mode').value,
    textOutline: $('#campaign-text-outline').checked,
    fps: $('#campaign-fps').value === 'keep' ? 'keep' : campaignNumber('#campaign-fps', 30),
    bitrateKbps: campaignNumber('#campaign-bitrate-kbps', 8000),
    colorCorrectionEnabled: $('#campaign-color-correction-enabled').checked,
    colorStrength: campaignNumber('#campaign-color-strength', 35),
    audioMode: $('#campaign-audio-mode').value,
    audioPath: $('#campaign-audio-path').value.trim(),
    metadataMode: 'clean',
    metadataPresetId: currentCampaignMetadataPreset().id,
    metadataLines: campaignMetadataLines(),
    addToLibrary: $('#campaign-add-to-library').checked,
  };
}

async function createCampaign(event) {
  event.preventDefault();
  const sourcePaths = [...$('#campaign-inputs').selectedOptions].map(option => option.value).filter(Boolean);
  const outputCount = Math.floor(Number($('#campaign-output-count').value));
  const message = '#campaign-message';
  if (!sourcePaths.length) return setMessage(message, 'Выберите хотя бы один исходный ролик из библиотеки.', 'error');
  if (!Number.isInteger(outputCount) || outputCount < 1) return setMessage(message, 'Укажите положительное количество готовых роликов.', 'error');
  const distributionEnabled = $('#campaign-enable-distribution').checked;
  if (distributionEnabled && !state.campaignProfileIds.size) return setMessage(message, 'Для распределения выберите хотя бы один профиль Dolphin.', 'error');
  const speedMin = Number($('#campaign-speed-min').value);
  const speedMax = Number($('#campaign-speed-max').value);
  if (!Number.isFinite(speedMin) || !Number.isFinite(speedMax) || speedMin > speedMax) return setMessage(message, 'Минимальная скорость не может быть больше максимальной.', 'error');
  const overlayBlurMin = campaignNumber('#campaign-overlay-blur-min', 0);
  const overlayBlurMax = campaignNumber('#campaign-overlay-blur-max', 0);
  if (overlayBlurMin > overlayBlurMax) return setMessage(message, 'Минимальное размытие оверлея не может быть больше максимального.', 'error');
  const bitrateKbps = campaignNumber('#campaign-bitrate-kbps', 0);
  if (!Number.isInteger(bitrateKbps) || bitrateKbps < 500 || bitrateKbps > 50000) return setMessage(message, 'Укажите битрейт от 500 до 50 000 Кбит/с.', 'error');
  const schedule = $('#campaign-schedule').value;
  const recipe = campaignRecipePayload();
  const body = {
    sourcePaths,
    outputCount,
    outputFolder: $('#campaign-output-folder').value.trim(),
    outputTemplate: $('#campaign-output-template').value.trim(),
    presetId: recipe.presetId,
    recipe,
    profileIds: distributionEnabled ? [...state.campaignProfileIds] : [],
    distributionEnabled,
    titleTemplate: $('#campaign-title-template').value.trim(),
    descriptionTemplate: $('#campaign-description-template').value.trim(),
    tags: $('#campaign-tags').value.split(',').map(tag => tag.trim()).filter(Boolean),
    autoStart: $('#campaign-auto-start').checked,
    processingConcurrency: Number($('#campaign-processing-concurrency').value),
    uploadConcurrency: Number($('#campaign-upload-concurrency').value),
    scheduledAt: schedule ? new Date(schedule).toISOString() : null,
  };
  if (!body.outputFolder || !body.outputTemplate || (distributionEnabled && !body.titleTemplate)) {
    return setMessage(message, distributionEnabled ? 'Укажите папку, шаблон имени и шаблон заголовка.' : 'Укажите папку и шаблон имени.', 'error');
  }
  const button = $('#campaign-submit');
  button.disabled = true;
  button.textContent = 'Создаём кампанию…';
  try {
    const result = await api('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const campaign = result.campaign || result;
    setMessage(message, body.autoStart
      ? `Кампания создана: ${campaign.outputCount || outputCount} результатов поставлены в конвейер${distributionEnabled ? ' с распределением по профилям.' : '.'}`
      : `Кампания создана: ${campaign.outputCount || outputCount} результатов ожидают запуска.`);
    $('#campaign-form').reset();
    $('#campaign-output-count').value = '10';
    $('#campaign-processing-concurrency').value = '1';
    syncCampaignProcessingConcurrency();
    $('#campaign-upload-concurrency').value = '5';
    $('#campaign-add-to-library').checked = true;
    $('#campaign-auto-start').checked = true;
    $('#campaign-enable-distribution').checked = false;
    state.campaignProfileIds = new Set();
    renderCampaignSourcePicker();
    renderCampaignProfilePicker();
    updateCampaignDistributionControls();
    applyCampaignPreset('manual');
    await Promise.all([loadCampaigns(), loadLogs(), loadWorkerSettings()]);
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Создать кампанию';
  }
}

async function runCampaign(id, button) {
  const text = button.textContent;
  button.disabled = true;
  button.textContent = 'Запуск…';
  try {
    await api(`/api/campaigns/${encodeURIComponent(id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await Promise.all([loadCampaigns(), loadLogs(), loadWorkerSettings()]);
  } catch (error) {
    button.textContent = error.message;
    setTimeout(() => { button.textContent = text; button.disabled = false; }, 2500);
  }
}

async function loadHealth() {
  state.health = await api('/api/health');
  const online = state.health.remoteApi && state.health.localReachable;
  const automationConfirmed = state.health.localAuthorized;
  const localLabel = automationConfirmed
    ? 'доступ подтверждён'
    : state.health.localReachable
      ? 'приложение найдено; доступ проверяется при операции'
    : 'локальное приложение недоступно';
  $('#side-status').textContent = online ? (automationConfirmed ? 'Dolphin подключён' : 'Dolphin найден') : 'Проверьте Dolphin';
  const notice = $('#connection-notice');
  notice.className = `notice ${online && automationConfirmed ? '' : 'warn'}`;
  notice.textContent = online
    ? automationConfirmed
      ? 'Creator Flow подключён к Dolphin. Данные страниц загружаются только по вашему действию.'
      : 'Creator Flow видит Dolphin и его облачный API. Доступ к Automation API будет подтверждён при первой операции с профилем.'
    : `Статус: ${state.health.remoteApi ? 'API Dolphin доступен, но локальное приложение не отвечает.' : 'API Dolphin недоступен. Проверьте ключ и запущенное приложение Dolphin.'}`;
  $('#settings-health').className = `notice ${online && automationConfirmed ? '' : 'warn'}`;
  $('#settings-health').textContent = online
    ? automationConfirmed ? 'Dolphin API и Automation API доступны.' : 'Dolphin API доступен; доступ к Automation API будет проверен при запуске профиля.'
    : 'Нет полного подключения к Dolphin.';
  $('#settings-automation').textContent = localLabel;
  renderWorkspaceStatus();
}

async function loadProfiles() {
  const response = await api('/api/profiles');
  state.profiles = response.data || response.profiles || response.items || [];
  const availableIds = new Set(state.profiles.map(profileIdOf));
  state.bulkProfileIds = new Set([...state.bulkProfileIds].filter(id => availableIds.has(id)));
  state.channelBulkProfileIds = new Set([...state.channelBulkProfileIds].filter(id => availableIds.has(id)));
  state.campaignProfileIds = new Set([...state.campaignProfileIds].filter(id => availableIds.has(id)));
  ['#task-profile', '#channel-profile', '#analytics-profile'].forEach(selector => fillProfileSelect($(selector)));
  $('#metric-profiles').textContent = formatNumber(state.profiles.length);
  renderProfiles(); renderAccounts(); renderBulkProfilePicker(); renderChannelBulkProfilePicker(); renderCampaignProfilePicker(); renderWorkspaceStatus();
}

async function loadAccounts() {
  const response = await api('/api/accounts');
  state.accountStates = new Map((response.accounts || []).map(account => [String(account.profileId), account]));
  renderProfiles();
  renderAccounts();
  renderBulkProfilePicker();
  renderCampaignProfilePicker();
  renderWorkspaceStatus();
}

function renderFolderSelect() {
  const select = $('#profile-create-folder');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">Без папки</option>' + state.folders
    .map(folder => `<option value="${escapeHtml(folder.id)}">${escapeHtml(`${folder.emoji ? `${folder.emoji} ` : ''}${folder.name}`)}</option>`)
    .join('');
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

async function loadFolders() {
  const response = await api('/api/folders');
  state.folders = response.data || response.folders || [];
  renderFolderSelect();
}

async function loadTasks() {
  const response = await api('/api/tasks');
  state.tasks = response.tasks || [];
  $('#metric-queue').textContent = formatNumber(state.tasks.filter(task => !['cancelled', 'awaiting-review'].includes(task.status)).length);
  renderTasks(); renderOverviewTasks(); renderWorkspaceStatus();
}

async function loadLibrary() {
  const response = await api('/api/library');
  state.library = response.library || [];
  fillLibrarySelect($('#task-library')); fillLibrarySelect($('#render-source'), false);
  renderProcessingInputPicker();
  renderCampaignSourcePicker();
  $('#metric-library').textContent = formatNumber(state.library.length);
  renderLibrary(); renderWorkspaceStatus();
}

async function loadChannelTasks() {
  const response = await api('/api/channels/tasks');
  state.channelTasks = response.tasks || [];
  renderChannelTasks();
}

async function loadProcessingBatches() {
  const response = await api('/api/processing/batches');
  state.processingBatches = response.batches || [];
  state.processingProcessor = response.processor || null;
  renderProcessingBatches();
}

async function loadCampaigns() {
  const target = $('#campaign-results');
  if (!target) return;
  try {
    const response = await api('/api/campaigns');
    state.campaigns = Array.isArray(response) ? response : (response.campaigns || response.items || []);
    state.campaignApiAvailable = true;
    renderCampaigns();
  } catch (error) {
    state.campaignApiAvailable = false;
    renderCampaigns(error);
  }
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
  renderWorkspaceStatus();
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
    await Promise.all([loadProfiles(), loadAccounts(), loadTasks(), loadLibrary(), loadChannelTasks(), loadProcessingBatches(), loadCampaigns(), loadLogs(), loadProxies(), loadFfmpeg(), loadWorkerSettings(), loadStudioBatches(), loadAccountBatches(), loadFolders()]);
    await refreshAnalyticsView();
  } catch (error) {
    const notice = $('#connection-notice'); notice.className = 'notice error'; notice.textContent = error.message;
  } finally { $('#refresh-all').disabled = false; }
}

let liveRefreshRunning = false;
async function refreshLiveState() {
  if (liveRefreshRunning) return;
  liveRefreshRunning = true;
  try {
    await Promise.all([loadTasks(), loadLogs(), loadWorkerSettings(), loadStudioBatches(), loadAccounts(), loadAccountBatches(), loadProcessingBatches(), loadCampaigns(), loadLibrary()]);
    if ($('#analytics').classList.contains('active')) await refreshAnalyticsView();
  } catch {
    // The main refresh action keeps connection errors visible; background refresh stays quiet.
  } finally {
    liveRefreshRunning = false;
  }
}

function renderProfiles() {
  return renderProfileCatalog();
}

function bindProfileControls(target) {
  target.querySelectorAll('[data-profile-start]').forEach(button => button.onclick = () => controlProfile(button.dataset.profileStart, 'start', button));
  target.querySelectorAll('[data-profile-stop]').forEach(button => button.onclick = () => controlProfile(button.dataset.profileStop, 'stop', button));
  target.querySelectorAll('[data-profile-channel]').forEach(button => button.onclick = () => {
    fillProfileSelect($('#channel-profile'), button.dataset.profileChannel);
    activatePage('channels');
  });
}

function renderProfileCatalog() {
  const target = $('#profiles-list');
  if (!state.profiles.length) {
    target.innerHTML = '<div class="empty">Dolphin не вернул профили. Обновите подключение и проверьте API.</div>';
    return;
  }
  const checked = [...state.accountStates.values()];
  const connected = checked.filter(item => item?.status === 'connected').length;
  const attention = checked.filter(item => item?.status === 'manual-login-required' || item?.status === 'error').length;
  let summary = $('#profiles-summary');
  if (!summary) {
    summary = document.createElement('div');
    summary.id = 'profiles-summary';
    summary.className = 'control-summary';
    target.before(summary);
  }
  summary.innerHTML = `<div class="summary-kpis"><span class="summary-kpi"><b>${state.profiles.length}</b> всего</span><span class="summary-kpi ok"><b>${connected}</b> YouTube подключено</span><span class="summary-kpi ${attention ? 'warn' : ''}"><b>${attention}</b> требуют внимания</span></div><div class="segmented" aria-label="Быстрые действия"><button type="button" data-profiles-refresh>Обновить статусы</button><button type="button" data-profiles-accounts>Открыть аккаунты</button></div>`;
  summary.querySelector('[data-profiles-refresh]').onclick = () => refreshProfileList();
  summary.querySelector('[data-profiles-accounts]').onclick = () => activatePage('accounts');
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile);
    const present = accountPresentation(profile);
    const statusClass = present.tone === 'ok' ? 'ok' : present.tone === 'warn' ? 'warn' : present.tone === 'bad' ? 'bad' : '';
    const avatarClass = present.tone === 'warn' ? 'warning' : present.tone === 'bad' ? 'error' : '';
    return `<article class="profile-card"><span class="profile-avatar ${avatarClass}">${escapeHtml(profileInitials(profile))}</span><div class="profile-copy"><div class="profile-heading"><b>${escapeHtml(profileNameOf(profile))}</b>${statusPill(present.account?.status || 'unchecked', present.badge)}</div><div class="profile-meta-grid"><span class="meta-tag">ID ${escapeHtml(id)}</span>${profileTags(profile)}</div><div class="profile-status-line"><i class="status-dot ${statusClass}"></i><span>${escapeHtml(present.label)}</span></div></div><div class="profile-actions"><button class="btn" data-profile-start="${escapeHtml(id)}">Запустить</button><button class="btn" data-profile-stop="${escapeHtml(id)}">Остановить</button><button class="btn primary" data-profile-channel="${escapeHtml(id)}">Канал</button></div></article>`;
  }).join('');
  bindProfileControls(target);
}

function renderAccounts() {
  return renderAccountCatalog();
}

function renderAccountCatalog() {
  const target = $('#accounts-list');
  if (!target) return;
  if (!state.profiles.length) {
    target.innerHTML = '<div class="empty">Профили Dolphin не найдены. Сначала обновите подключение к Dolphin.</div>';
    return;
  }
  const records = state.profiles.map(profile => ({ profile, present: accountPresentation(profile) }));
  const checked = records.filter(({ present }) => present.account).length;
  const connected = records.filter(({ present }) => present.tone === 'ok').length;
  const manual = records.filter(({ present }) => present.tone === 'warn').length;
  let summary = $('#accounts-summary');
  if (!summary) {
    summary = document.createElement('div');
    summary.id = 'accounts-summary';
    summary.className = 'control-summary';
    target.before(summary);
  }
  summary.innerHTML = `<div class="summary-kpis"><span class="summary-kpi"><b>${checked}/${records.length}</b> проверено</span><span class="summary-kpi ok"><b>${connected}</b> подключено</span><span class="summary-kpi ${manual ? 'warn' : ''}"><b>${manual}</b> нужен вход</span></div><div class="segmented"><button type="button" data-accounts-check-all>Проверить все</button></div>`;
  summary.querySelector('[data-accounts-check-all]').onclick = () => checkAllAccounts();
  target.innerHTML = records.map(({ profile, present }) => {
    const id = profileIdOf(profile);
    const analytics = state.analytics.get(id);
    const channelName = present.account?.channelName || 'Канал будет показан после проверки';
    const auxiliary = analytics?.syncedAt ? `${analytics.total || 0} роликов в последней синхронизации` : 'Ручной вход и 2FA выполняются только в профиле Dolphin';
    const avatarClass = present.tone === 'warn' ? 'warning' : present.tone === 'bad' ? 'error' : '';
    return `<article class="profile-card account-card"><span class="profile-avatar ${avatarClass}">${escapeHtml(profileInitials(profile))}</span><div class="profile-copy"><div class="profile-heading"><b>${escapeHtml(profileNameOf(profile))}</b>${statusPill(present.account?.status || 'unchecked', present.badge)}</div><div class="profile-meta-grid"><span class="meta-tag">Dolphin ${escapeHtml(id)}</span>${profileTags(profile)}</div><div class="profile-status-line"><i class="status-dot ${present.tone === 'ok' ? 'ok' : present.tone === 'warn' ? 'warn' : present.tone === 'bad' ? 'bad' : ''}"></i><span>${escapeHtml(present.label)}</span></div></div><div class="account-signal"><span class="signal-label">YouTube Studio</span><b>${escapeHtml(channelName)}</b><small>${escapeHtml(auxiliary)}</small></div><div class="account-actions"><button class="btn" data-account-channel="${escapeHtml(id)}">Канал</button><button class="btn primary" data-account-check="${escapeHtml(id)}">Проверить</button></div></article>`;
  }).join('');
  target.querySelectorAll('[data-account-check]').forEach(button => button.onclick = () => checkAccount(button.dataset.accountCheck, button));
  target.querySelectorAll('[data-account-channel]').forEach(button => button.onclick = () => {
    fillProfileSelect($('#channel-profile'), button.dataset.accountChannel);
    activatePage('channels');
  });
}

function accountBatchSummary(batch) {
  const items = batch.items || [];
  const total = Number(batch.total ?? items.length);
  const completed = Number(batch.completed ?? items.filter(item => item.status === 'completed').length);
  const failed = Number(batch.failed ?? items.filter(item => item.status === 'error').length);
  const running = Number(batch.running ?? items.filter(item => item.status === 'running').length);
  const needsLogin = Number(batch.manualLoginRequired ?? items.filter(item => item.status === 'manual-login-required').length);
  const queued = Number(batch.queued ?? Math.max(0, total - completed - failed - running - needsLogin));
  return { total, completed, failed, running, needsLogin, queued };
}

function renderAccountBatches() {
  const target = $('#account-batches');
  if (!target) return;
  if (!state.accountBatches.length) {
    target.innerHTML = '<div class="empty">Пакетных проверок пока нет.</div>';
    return;
  }
  target.innerHTML = state.accountBatches.slice(0, 8).map(batch => {
    const summary = accountBatchSummary(batch);
    const attention = (batch.items || []).filter(item => ['manual-login-required', 'error'].includes(item.status)).slice(0, 4);
    const detail = attention.map(item => `${escapeHtml(item.profileId)}: ${item.status === 'manual-login-required' ? 'нужен вход' : 'проверка не выполнена'}`).join('<br>');
    return `<div class="list-row"><div><b>Проверка ${escapeHtml(String(batch.id).slice(0, 8))}</b><div class="meta">${formatDate(batch.createdAt)} · ${escapeHtml(batch.status || 'queued')}</div>${detail ? `<div class="small error">${detail}</div>` : ''}</div><div class="right"><b>${summary.completed}/${summary.total}</b><div class="small">готово · ${summary.running} в работе · ${summary.queued} в очереди${summary.needsLogin ? ` · ${summary.needsLogin} нужен вход` : ''}${summary.failed ? ` · ${summary.failed} ошибок` : ''}</div></div></div>`;
  }).join('');
}

async function loadAccountBatches() {
  const response = await api('/api/accounts/check-batches');
  state.accountBatches = response.batches || [];
  renderAccountBatches();
}

async function checkAllAccounts() {
  const button = $('[data-accounts-check-all]');
  if (button) { button.disabled = true; button.textContent = 'Проверка…'; }
  try {
    const response = await api('/api/accounts/check-batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: state.profiles.map(profileIdOf) }),
    });
    await Promise.all([loadAccountBatches(), loadLogs(), loadWorkerSettings()]);
    setMessage('#accounts-message', `Проверка поставлена в очередь: ${response.batch?.total || state.profiles.length} профилей.`);
  } catch (error) {
    setMessage('#accounts-message', error.message, 'error');
  } finally {
    renderAccountCatalog();
  }
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
    renderWorkspaceStatus();
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
  return renderTaskCard(task);
}

function renderTaskCard(task) {
  const actions = [];
  if (task.status === 'queued') actions.push(`<button class="btn" data-task-action="run" data-task-id="${escapeHtml(task.id)}">Запустить</button>`);
  if (task.status === 'profile-ready') actions.push(`<button class="btn primary" data-task-action="upload" data-task-id="${escapeHtml(task.id)}">Загрузить</button>`);
  if (task.status === 'manual-login-required') {
    actions.push(task.manualSessionOpen
      ? `<button class="btn primary" data-task-action="continue-upload" data-task-id="${escapeHtml(task.id)}">Проверить вход</button>`
      : `<button class="btn warning" data-task-action="prepare-login" data-task-id="${escapeHtml(task.id)}">Открыть вход</button>`);
  }
  if (task.status === 'login-ready') actions.push(`<button class="btn primary" data-task-action="continue-upload" data-task-id="${escapeHtml(task.id)}">Продолжить</button>`);
  if (!['cancelled', 'awaiting-review', 'error', 'completed'].includes(task.status)) actions.push(`<button class="btn danger" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}">Отменить</button>`);
  const profile = state.profiles.find(item => profileIdOf(item) === String(task.profileId));
  const profileName = profile ? profileNameOf(profile) : task.profileId;
  const timing = task.scheduledAt ? `запуск ${formatDate(task.scheduledAt)}` : 'ручной запуск';
  return `<article class="task"><span class="number">▶</span><div class="task-copy"><div class="task-title-row"><b>${escapeHtml(task.title)}</b>${statusPill(task.status, taskStatusLabel(task.status))}</div><small>${escapeHtml(profileName)} · ${timing}${task.message ? ` · ${escapeHtml(task.message)}` : ''}</small>${taskStage(task.status)}</div><div class="task-side"><span class="meta-tag accent">${escapeHtml(profileName)}</span><div class="profile-actions">${actions.join('')}</div></div></article>`;
}

function renderBulkProfilePicker() {
  const target = $('#bulk-profile-picker');
  const counter = $('#bulk-profile-count');
  if (!target || !counter) return;
  const selected = state.bulkProfileIds;
  const ids = state.profiles.map(profileIdOf);
  counter.textContent = `Выбрано: ${selected.size} из ${ids.length}`;
  if (!ids.length) {
    target.innerHTML = '<div class="empty">Сначала подключите хотя бы один профиль Dolphin.</div>';
    return;
  }
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile);
    const present = accountPresentation(profile);
    return `<label class="bulk-profile-option"><input type="checkbox" value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}><span class="profile-avatar ${present.tone === 'warn' ? 'warning' : present.tone === 'bad' ? 'error' : ''}">${escapeHtml(profileInitials(profile))}</span><span class="bulk-profile-copy"><b>${escapeHtml(profileNameOf(profile))}</b><small>${escapeHtml(present.label)}</small></span></label>`;
  }).join('');
  target.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.onchange = () => {
      if (input.checked) state.bulkProfileIds.add(input.value);
      else state.bulkProfileIds.delete(input.value);
      counter.textContent = `Выбрано: ${state.bulkProfileIds.size} из ${ids.length}`;
    };
  });
}

function setAllBulkProfiles(selected) {
  state.bulkProfileIds = selected ? new Set(state.profiles.map(profileIdOf)) : new Set();
  renderBulkProfilePicker();
}

async function createBulkQueue(event) {
  event.preventDefault();
  if (!state.bulkProfileIds.size) return setMessage('#bulk-form-message', 'Выберите хотя бы один профиль Dolphin.', 'error');
  const scheduledValue = $('#bulk-scheduled').value;
  const body = {
    profileIds: [...state.bulkProfileIds],
    videoPath: $('#bulk-video-path').value.trim(),
    titleTemplate: $('#bulk-title-template').value.trim(),
    description: $('#bulk-description').value.trim(),
    tags: $('#bulk-tags').value.split(',').map(tag => tag.trim()).filter(Boolean),
    scheduledAt: scheduledValue ? new Date(scheduledValue).toISOString() : null,
    autoUpload: $('#bulk-auto-upload').checked,
  };
  const submit = $('#bulk-submit');
  submit.disabled = true;
  submit.textContent = 'Добавление…';
  try {
    const response = await api('/api/tasks/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setMessage('#bulk-form-message', response.autoUpload
      ? `Пакет создан: ${response.created} задач. Автозапуск включён и будет идти по лимиту потоков.`
      : `Пакет создан: ${response.created} задач. Они добавлены в очередь без автоматического запуска.`);
    $('#bulk-form').reset();
    state.bulkProfileIds = new Set();
    renderBulkProfilePicker();
    await Promise.all([loadTasks(), loadLogs()]);
  } catch (error) {
    setMessage('#bulk-form-message', error.message, 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Добавить пакет в очередь';
  }
}

function renderChannelBulkProfilePicker() {
  const target = $('#channel-bulk-profile-picker');
  const counter = $('#channel-bulk-profile-count');
  if (!target || !counter) return;
  const selected = state.channelBulkProfileIds;
  const ids = state.profiles.map(profileIdOf);
  counter.textContent = `Выбрано: ${selected.size} из ${ids.length}`;
  if (!ids.length) {
    target.innerHTML = '<div class="empty">Сначала подключите хотя бы один профиль Dolphin.</div>';
    return;
  }
  target.innerHTML = state.profiles.map(profile => {
    const id = profileIdOf(profile);
    const present = accountPresentation(profile);
    return `<label class="bulk-profile-option"><input type="checkbox" value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}><span class="profile-avatar ${present.tone === 'warn' ? 'warning' : present.tone === 'bad' ? 'error' : ''}">${escapeHtml(profileInitials(profile))}</span><span class="bulk-profile-copy"><b>${escapeHtml(profileNameOf(profile))}</b><small>${escapeHtml(present.label)}</small></span></label>`;
  }).join('');
  target.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.onchange = () => {
      if (input.checked) state.channelBulkProfileIds.add(input.value);
      else state.channelBulkProfileIds.delete(input.value);
      counter.textContent = `Выбрано: ${state.channelBulkProfileIds.size} из ${ids.length}`;
    };
  });
}

function setAllChannelBulkProfiles(selected) {
  state.channelBulkProfileIds = selected ? new Set(state.profiles.map(profileIdOf)) : new Set();
  renderChannelBulkProfilePicker();
}

function parseChannelLinks(value) {
  return String(value || '').split(/\r?\n/)
    .map(line => line.split('|').map(part => part.trim()))
    .filter(parts => parts[0] && parts[1])
    .map(([title, url]) => ({ title, url }));
}

async function createBulkChannelTasks(event) {
  event.preventDefault();
  if (!state.channelBulkProfileIds.size) return setMessage('#channel-bulk-message', 'Выберите хотя бы один профиль Dolphin.', 'error');
  const body = {
    profileIds: [...state.channelBulkProfileIds],
    name: $('#channel-bulk-name').value.trim(),
    description: $('#channel-bulk-description').value.trim(),
    avatarPath: $('#channel-bulk-avatar').value.trim(),
    bannerPath: $('#channel-bulk-banner').value.trim(),
    links: parseChannelLinks($('#channel-bulk-links').value),
    autoRun: $('#channel-bulk-auto-run').checked,
  };
  const button = $('#channel-bulk-submit');
  button.disabled = true;
  button.textContent = 'Создание…';
  try {
    const response = await api('/api/channels/tasks/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setMessage('#channel-bulk-message', response.autoRun
      ? `Создан пакет из ${response.created} задач. Оформление запускается по доступным потокам.`
      : `Создан пакет из ${response.created} задач. Запустите его из списка задач оформления.`);
    $('#channel-bulk-form').reset();
    state.channelBulkProfileIds = new Set();
    renderChannelBulkProfilePicker();
    await Promise.all([loadChannelTasks(), loadLogs(), loadWorkerSettings()]);
  } catch (error) {
    setMessage('#channel-bulk-message', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Применить к выбранным каналам';
  }
}

async function createDolphinProfile(event) {
  event.preventDefault();
  const button = $('#profile-create-submit');
  const body = {
    name: $('#profile-create-name').value.trim(),
    platform: $('#profile-create-platform').value,
    platformVersion: $('#profile-create-platform-version').value.trim(),
    browserVersion: Number($('#profile-create-browser-version').value),
    folderId: $('#profile-create-folder').value || null,
    tags: $('#profile-create-tags').value.split(',').map(tag => tag.trim()).filter(Boolean),
  };
  button.disabled = true;
  button.textContent = 'Создание…';
  try {
    const response = await api('/api/profiles/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setMessage('#profile-create-message', `Профиль «${response.profile?.name || body.name}» создан в Dolphin.`);
    $('#profile-create-form').reset();
    $('#profile-create-platform').value = 'windows';
    $('#profile-create-platform-version').value = '10.0.0';
    $('#profile-create-browser-version').value = '136';
    await Promise.all([loadProfiles(), loadFolders(), loadLogs()]);
  } catch (error) {
    setMessage('#profile-create-message', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Создать профиль';
  }
}

async function createDolphinFolder(event) {
  event.preventDefault();
  const name = $('#folder-create-name').value.trim();
  const button = $('#folder-create-submit');
  if (!name) return setMessage('#folder-create-message', 'Укажите название папки.', 'error');
  button.disabled = true;
  button.textContent = '…';
  try {
    const response = await api('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    $('#folder-create-name').value = '';
    setMessage('#folder-create-message', `Папка «${response.folder?.name || name}» создана.`);
    await Promise.all([loadFolders(), loadLogs()]);
    if (response.folder?.id !== undefined) $('#profile-create-folder').value = String(response.folder.id);
  } catch (error) {
    setMessage('#folder-create-message', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Создать';
  }
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
  target.innerHTML = state.channelTasks.length ? state.channelTasks.map(task => {
    const profile = state.profiles.find(item => profileIdOf(item) === String(task.profileId));
    const profileName = profile ? profileNameOf(profile) : task.profileId;
    const automatic = task.source === 'bulk-channel' ? 'пакет' : 'один канал';
    const canRun = ['queued', 'error', 'recovery-needed', 'manual-login-required'].includes(task.status);
    const detail = task.message || task.error || '';
    const saveProof = task.status === 'completed' && task.result?.saveConfirmed
      ? ' · Studio подтвердил сохранение'
      : '';
    return `<article class="task"><span class="number">✎</span><div class="task-copy"><div class="task-title-row"><b>${escapeHtml(task.name || 'Изменение оформления')}</b>${statusPill(task.status, taskStatusLabel(task.status))}</div><small>${escapeHtml(profileName)} · ${automatic}${detail ? ` · ${escapeHtml(detail)}` : ''}${saveProof}</small>${taskStage(task.status)}</div><div class="task-side"><span class="meta-tag accent">${escapeHtml(profileName)}</span><div class="profile-actions">${canRun ? `<button class="btn primary" data-channel-task="${escapeHtml(task.id)}">Применить</button>` : ''}</div></div></article>`;
  }).join('') : '<div class="empty">Задач оформления пока нет.</div>';
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
  const needsLogin = Number(batch.manualLoginRequired ?? items.filter(item => item.status === 'manual-login-required').length);
  const queued = Number(batch.queued ?? Math.max(0, total - completed - failed - running - needsLogin));
  return { total, completed, failed, running, needsLogin, queued };
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
    const details = (batch.items || []).filter(item => ['error', 'manual-login-required'].includes(item.status)).slice(0, 3)
      .map(item => `${escapeHtml(item.profileId)}: ${item.status === 'manual-login-required' ? 'нужен вход' : escapeHtml(item.error || 'ошибка')}`).join('<br>');
    return `<div class="list-row"><div><b>Пакет ${escapeHtml(String(batch.id).slice(0, 8))}</b><div class="meta">${formatDate(batch.createdAt)} · ${escapeHtml(batch.status || 'queued')}</div>${details ? `<div class="small error">${details}</div>` : ''}</div><div class="right"><b>${summary.completed}/${summary.total}</b><div class="small">готово · ${summary.running} в работе · ${summary.queued} в очереди${summary.needsLogin ? ` · ${summary.needsLogin} нужен вход` : ''}${summary.failed ? ` · ${summary.failed} ошибок` : ''}</div></div></div>`;
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
  $('#profiles-refresh').onclick = () => refreshProfileList();
  $('#accounts-refresh').onclick = () => refreshAccountList();
  $('#profile-create-form').onsubmit = createDolphinProfile;
  $('#folder-create-form').onsubmit = createDolphinFolder;
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
  $('#bulk-form').onsubmit = createBulkQueue;
  $('#bulk-select-all').onclick = () => setAllBulkProfiles(true);
  $('#bulk-select-none').onclick = () => setAllBulkProfiles(false);
  $('#library-upload').onclick = uploadLibraryFiles;
  $('#library-import-path').onclick = importLibraryPath;
  $('#campaign-form').onsubmit = createCampaign;
  $('#campaign-refresh').onclick = () => Promise.all([loadCampaigns(), loadLibrary(), loadProfiles(), loadAccounts()]);
  $('#campaign-preset').onchange = event => applyCampaignPreset(event.target.value);
  $('#campaign-output-count').oninput = updateCampaignPlan;
  $('#campaign-enable-distribution').onchange = updateCampaignDistributionControls;
  $('#campaign-select-connected').onclick = () => setCampaignProfiles('connected');
  $('#campaign-select-all').onclick = () => setCampaignProfiles('all');
  $('#campaign-select-none').onclick = () => setCampaignProfiles('none');
  $$('[data-campaign-recipe-tab]').forEach(button => button.onclick = () => setCampaignRecipeTab(button.dataset.campaignRecipeTab));
  $$('[data-range-output]').forEach(input => {
    updateCampaignRangeOutput(input);
    input.addEventListener('input', () => {
      updateCampaignRangeOutput(input);
      updateCampaignRecipeSummary();
    });
  });
  const recipeControls = [
    '#campaign-overlay', '#campaign-use-preset-overlay', '#campaign-overlay-position', '#campaign-overlay-width', '#campaign-text-variations', '#campaign-font-path',
    '#campaign-text-size', '#campaign-text-color-mode', '#campaign-text-outline', '#campaign-layout', '#campaign-crop',
    '#campaign-speed-min', '#campaign-speed-max', '#campaign-fps', '#campaign-bitrate-kbps', '#campaign-color-correction-enabled',
    '#campaign-audio-mode', '#campaign-audio-path', '#campaign-metadata-preset', '#campaign-metadata-lines', '#campaign-add-to-library',
  ];
  recipeControls.forEach(selector => {
    const control = $(selector);
    if (!control) return;
    control.addEventListener('input', updateCampaignRecipeSummary);
    control.addEventListener('change', updateCampaignRecipeSummary);
  });
  $('#campaign-metadata-file').onchange = importCampaignMetadataFile;
  $('#campaign-processing-concurrency').onchange = () => syncCampaignProcessingConcurrency();
  $('#campaign-processing-concurrency-copy').onchange = () => syncCampaignProcessingConcurrency('copy');
  syncCampaignProcessingConcurrency();
  applyCampaignPreset(currentCampaignPreset().id);
  $('#channel-read').onclick = () => readChannel(false);
  $('#channel-form').onsubmit = createChannelTask;
  $('#channel-bulk-form').onsubmit = createBulkChannelTasks;
  $('#channel-bulk-select-all').onclick = () => setAllChannelBulkProfiles(true);
  $('#channel-bulk-select-none').onclick = () => setAllChannelBulkProfiles(false);
  $('#render-form').onsubmit = renderVideo;
  $('#processing-batch-form').onsubmit = createProcessingBatch;
  $('#analytics-profile').onchange = refreshAnalyticsView;
  $('#analytics-sync').onclick = () => syncAnalytics(false);
  $('#analytics-sync-all').onclick = syncAllAnalytics;
  $('#proxy-import').onclick = importProxies;
  $('#settings-save-concurrency').onclick = saveWorkerSettings;
}

async function refreshProfileList() {
  try {
    await Promise.all([loadProfiles(), loadFolders()]);
    setMessage('#profiles-message', 'Список профилей обновлён.');
  } catch (error) {
    setMessage('#profiles-message', error.message, 'error');
  }
}

async function refreshAccountList() {
  try {
    await Promise.all([loadProfiles(), loadAccounts(), loadAccountBatches()]);
    setMessage('#accounts-message', 'Список аккаунтов обновлён.');
  } catch (error) {
    setMessage('#accounts-message', error.message, 'error');
  }
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
  const links = parseChannelLinks($('#channel-links').value);
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

function processingBatchSummary(batch) {
  const items = batch.items || [];
  return {
    total: Number(batch.total ?? items.length),
    queued: Number(batch.queued ?? items.filter(item => item.status === 'queued').length),
    running: Number(batch.running ?? items.filter(item => item.status === 'running').length),
    completed: Number(batch.completed ?? items.filter(item => item.status === 'completed').length),
    failed: Number(batch.failed ?? items.filter(item => item.status === 'error').length),
    recoveryNeeded: Number(batch.recoveryNeeded ?? items.filter(item => item.status === 'recovery-needed').length),
  };
}

function processingFileName(item) {
  const raw = String(item?.fileName || item?.filePath || 'ролик');
  return raw.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'ролик';
}

function joinProcessingOutput(folder, fileName) {
  const trimmedFolder = String(folder || '').trim().replace(/[\\/]+$/, '');
  const separator = trimmedFolder.includes('\\') ? '\\' : '/';
  return `${trimmedFolder}${separator}${fileName}`;
}

function renderProcessingBatches() {
  const target = $('#processing-batches');
  if (!target) return;
  const processor = state.processingProcessor || { active: 0, limit: 3 };
  if (!state.processingBatches.length) {
    target.innerHTML = `<div class="empty">Пакетов пока нет. Локальный лимит: ${escapeHtml(String(processor.limit || 3))} FFmpeg-потока.</div>`;
    return;
  }
  target.innerHTML = state.processingBatches.slice(0, 12).map(batch => {
    const summary = processingBatchSummary(batch);
    const launchButton = summary.queued && batch.autoRun === false
      ? `<button class="btn" data-processing-run="${escapeHtml(batch.id)}">Запустить</button>`
      : '';
    const retryButton = (summary.failed || summary.recoveryNeeded)
      ? `<button class="btn warning" data-processing-retry-batch="${escapeHtml(batch.id)}">Повторить ошибки</button>`
      : '';
    const items = (batch.items || []).map(item => {
      const retry = ['error', 'recovery-needed'].includes(item.status)
        ? `<button class="btn warning" data-processing-retry-item="${escapeHtml(batch.id)}" data-processing-item="${escapeHtml(item.id)}">Повторить</button>`
        : '';
      const details = item.error || item.message || '';
      return `<div class="list-row"><div><b>${escapeHtml(processingFileName({ filePath: item.inputPath }))}</b><div class="meta">${escapeHtml(taskStatusLabel(item.status))}${details ? ` · ${escapeHtml(details)}` : ''}</div><span class="processing-output">→ ${escapeHtml(item.outputPath)}</span></div><div class="right"><span class="pill ${item.status === 'error' ? 'error' : ['queued', 'recovery-needed'].includes(item.status) ? 'wait' : ''}">${escapeHtml(taskStatusLabel(item.status))}</span>${retry ? `<div style="margin-top:7px">${retry}</div>` : ''}</div></div>`;
    }).join('');
    return `<div class="card" style="padding:14px"><div class="card-head"><div><h2>Пакет ${escapeHtml(String(batch.id).slice(0, 8))}</h2><p class="hint">${formatDate(batch.createdAt)} · ${batch.autoRun ? 'автозапуск включён' : 'ожидает ручного запуска'} · до ${escapeHtml(String(batch.concurrency || 1))} FFmpeg-потоков</p></div><div class="actions">${launchButton}${retryButton}</div></div><div class="processing-summary"><span><b>${summary.completed}</b> готово</span><span><b>${summary.running}</b> в работе</span><span><b>${summary.queued}</b> в очереди</span>${summary.failed ? `<span><b>${summary.failed}</b> ошибок</span>` : ''}${summary.recoveryNeeded ? `<span><b>${summary.recoveryNeeded}</b> требуют проверки</span>` : ''}</div><div class="list">${items}</div></div>`;
  }).join('');
  target.querySelectorAll('[data-processing-run]').forEach(button => {
    button.onclick = () => runProcessingBatch(button.dataset.processingRun, false, button);
  });
  target.querySelectorAll('[data-processing-retry-batch]').forEach(button => {
    button.onclick = () => runProcessingBatch(button.dataset.processingRetryBatch, true, button);
  });
  target.querySelectorAll('[data-processing-retry-item]').forEach(button => {
    button.onclick = () => retryProcessingItem(button.dataset.processingRetryItem, button.dataset.processingItem, button);
  });
}

async function runProcessingBatch(id, retryFailed, button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    await api(`/api/processing/batches/${encodeURIComponent(id)}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryFailed }),
    });
    await Promise.all([loadProcessingBatches(), loadLogs(), loadLibrary()]);
  } catch (error) {
    button.textContent = error.message;
    setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 2500);
  }
}

async function retryProcessingItem(batchId, itemId, button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    await api(`/api/processing/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    await Promise.all([loadProcessingBatches(), loadLogs(), loadLibrary()]);
  } catch (error) {
    button.textContent = error.message;
    setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 2500);
  }
}

async function createProcessingBatch(event) {
  event.preventDefault();
  const inputs = [...$('#processing-batch-inputs').selectedOptions].map(option => option.value).filter(Boolean);
  const outputFolder = $('#processing-output-folder').value.trim();
  const template = $('#processing-output-template').value.trim();
  const overlayPath = $('#processing-batch-overlay').value.trim();
  if (!inputs.length) return setMessage('#processing-batch-message', 'Выберите хотя бы один исходник из библиотеки.', 'error');
  if (inputs.length > 50) return setMessage('#processing-batch-message', 'В одном пакете доступно не более 50 исходников.', 'error');
  if (!outputFolder || !template) return setMessage('#processing-batch-message', 'Укажите папку и шаблон имени для результатов.', 'error');
  if (!template.toLowerCase().endsWith('.mp4')) return setMessage('#processing-batch-message', 'Шаблон имени должен оканчиваться на .mp4.', 'error');
  if (/[\\/]/.test(template)) return setMessage('#processing-batch-message', 'В шаблоне укажите только имя файла, без папок.', 'error');
  let jobs;
  try {
    const outputs = new Set();
    jobs = inputs.map((inputPath, index) => {
      const source = state.library.find(item => item.filePath === inputPath) || { filePath: inputPath };
      const fileName = template
        .replaceAll('{name}', processingFileName(source))
        .replaceAll('{index}', String(index + 1));
      const outputPath = joinProcessingOutput(outputFolder, fileName);
      if (outputs.has(outputPath)) throw new Error('Шаблон сформировал одинаковые имена результатов. Добавьте {index}.');
      outputs.add(outputPath);
      return { inputPath, outputPath, overlayPath };
    });
  } catch (error) {
    return setMessage('#processing-batch-message', error.message, 'error');
  }
  const button = $('#processing-batch-submit');
  button.disabled = true;
  button.textContent = 'Проверка путей…';
  setMessage('#processing-batch-message', `Проверяем ${jobs.length} исходников и создаём очередь…`);
  try {
    const result = await api('/api/processing/batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs, concurrency: Number($('#processing-batch-concurrency').value), autoRun: $('#processing-batch-auto-run').checked }),
    });
    setMessage('#processing-batch-message', result.batch.autoRun
      ? `Создан пакет: ${result.batch.total} отдельных выходных файлов поставлены в очередь.`
      : `Создан пакет из ${result.batch.total} файлов. Нажмите «Запустить» в карточке пакета.`);
    $('#processing-batch-inputs').selectedIndex = -1;
    renderProcessingInputPicker();
    await Promise.all([loadProcessingBatches(), loadLogs(), loadLibrary()]);
  } catch (error) {
    setMessage('#processing-batch-message', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Создать пакет обработки';
  }
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
  setInterval(() => refreshLiveState(), 8_000);
});
