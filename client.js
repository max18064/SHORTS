const api = async (url, options) => { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || data.message || 'Ошибка API'); return data; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
async function refreshCreatorFlow(){ const settings=document.querySelector('#settings .card'); if(!settings||document.querySelector('#cf-api-panel')) return; const panel=document.createElement('div'); panel.id='cf-api-panel'; panel.className='field'; panel.innerHTML='<label>Управление Dolphin</label><div class="row"><select class="input" id="cf-profile"><option>Загрузка профилей...</option></select><button class="btn" id="cf-profile-refresh">Обновить</button></div><div class="row" style="margin-top:8px"><button class="btn green" id="cf-profile-start">Запустить</button><button class="btn danger" id="cf-profile-stop">Остановить</button></div><small id="cf-profile-status">Ожидание подключения</small>'; settings.appendChild(panel); const select=panel.querySelector('#cf-profile'), status=panel.querySelector('#cf-profile-status'); const load=async()=>{try{const payload=await api('/api/profiles');const profiles=payload.data||payload.profiles||payload.items||[];select.innerHTML=profiles.length?profiles.map(p=>`<option value="${p.id||p.uuid}">${p.name||p.title||p.id||p.uuid}</option>`).join(''):'<option value="">Профили не найдены</option>';status.textContent=`Профилей получено: ${profiles.length}`;}catch(e){select.innerHTML='<option value="">Dolphin недоступен</option>';status.textContent=e.message;}}; panel.querySelector('#cf-profile-refresh').onclick=load; panel.querySelector('#cf-profile-start').onclick=async()=>{if(!select.value)return;status.textContent='Запуск профиля...';try{await api(`/api/profiles/${encodeURIComponent(select.value)}/start`,{method:'POST'});status.textContent='Профиль запущен';}catch(e){status.textContent=e.message;}}; panel.querySelector('#cf-profile-stop').onclick=async()=>{if(!select.value)return;status.textContent='Остановка профиля...';try{await api(`/api/profiles/${encodeURIComponent(select.value)}/stop`,{method:'POST'});status.textContent='Профиль остановлен';}catch(e){status.textContent=e.message;}}; await load(); }
document.addEventListener('DOMContentLoaded', async () => { await refreshCreatorFlow(); try { const health = await api('/api/health'); document.title = health.remoteApi ? 'Creator Flow · Dolphin online' : 'Creator Flow · Dolphin offline'; } catch {} });

async function refreshQueue() {
  const target = document.querySelector('#full-queue');
  if (!target) return;
  try {
    const payload = await api('/api/tasks');
    const tasks = payload.tasks || [];
    if (!tasks.length) { target.innerHTML = '<div class="empty">Очередь пока пуста</div>'; return; }
    target.innerHTML = tasks.map((task, index) => `<div class="task"><span class="num">${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(task.title)}</b><br><small>${escapeHtml(task.status)} · ${escapeHtml(task.profileId)}</small></span><span><span class="pill ${task.status === 'queued' ? 'wait' : ''}">${escapeHtml(task.status)}</span><br><button class="btn" data-run-task="${escapeHtml(task.id)}" data-action="run" style="padding:4px 7px;margin-top:5px">Профиль</button>${task.status === 'profile-ready' ? `<button class="btn green" data-run-task="${escapeHtml(task.id)}" data-action="upload" style="padding:4px 7px;margin-top:5px">Загрузить</button>` : ''}${task.status === 'manual-login-required' ? `<button class="btn green" data-run-task="${escapeHtml(task.id)}" data-action="upload" style="padding:4px 7px;margin-top:5px">Повторить загрузку</button>` : ''}${task.status === 'login-ready' ? `<button class="btn green" data-run-task="${escapeHtml(task.id)}" data-action="continue" style="padding:4px 7px;margin-top:5px">Продолжить загрузку</button>` : ''}</span></div>`).join('');
    target.querySelectorAll('[data-run-task]').forEach(button => { button.onclick = async () => { button.disabled = true; button.textContent = '...'; try { const action = button.dataset.action; const endpoint = action === 'continue' ? `/api/tasks/${button.dataset.runTask}/upload/continue` : action === 'upload' ? `/api/tasks/${button.dataset.runTask}/upload` : `/api/tasks/${button.dataset.runTask}/run`; await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await refreshQueue(); } catch (error) { button.disabled = false; button.textContent = error.message; } }; });
  } catch (error) { target.innerHTML = `<div class="empty">${error.message}</div>`; }
}

async function createQueueTask() {
  const profileId = window.prompt('ID профиля Dolphin');
  const videoPath = window.prompt('Полный путь к видео');
  const title = window.prompt('Заголовок ролика');
  if (!profileId || !videoPath || !title) return;
  try {
    await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, videoPath, title }) });
    await refreshQueue();
    window.alert('Задача добавлена в очередь');
  } catch (error) { window.alert(`Ошибка: ${error.message}`); }
}

document.addEventListener('DOMContentLoaded', () => {
  const add = document.querySelector('#add');
  if (add) add.onclick = createQueueTask;
  refreshQueue();
  enhanceUniqueizer();
  enhanceAnalytics();
  refreshAnalyticsData();
  enhanceOperations();
  enhanceChannelManager();
});

function enhanceChannelManager() {
  if (document.querySelector('#channels')) return;
  const nav = document.querySelector('.nav[data-page="editor"]');
  const page = document.createElement('section');
  page.className = 'page'; page.id = 'channels';
  page.innerHTML = '<div class="layout"><div class="card"><h2>Оформление YouTube-канала</h2><p class="hint">Выберите профиль Dolphin с уже выполненным ручным входом.</p><div id="cf-channel-panel"></div></div><div class="card"><h2>Задачи оформления</h2><div class="queue" id="cf-channel-tasks"></div></div></div>';
  document.querySelector('main').appendChild(page);
  const button = document.createElement('button'); button.className = 'nav'; button.dataset.page = 'channels'; button.innerHTML = '<i>◉</i>Каналы'; nav.before(button);
  button.onclick = () => { document.querySelectorAll('.nav').forEach(item => item.classList.remove('active')); button.classList.add('active'); document.querySelectorAll('.page').forEach(item => item.classList.remove('active')); page.classList.add('active'); document.querySelector('#title').textContent = 'Каналы'; };
  const panel = page.querySelector('#cf-channel-panel');
  panel.innerHTML = '<div class="field"><label>Профиль Dolphin</label><div class="row"><select class="input" id="cf-channel-profile"><option>Загрузка профилей…</option></select><button class="btn" id="cf-channel-sync">Считать канал</button></div><small id="cf-channel-identity">Данные канала ещё не считаны.</small></div><div class="field"><label>Новое название канала</label><input class="input" id="cf-channel-name" placeholder="Название"></div><div class="field"><label>Новое описание</label><textarea class="input" id="cf-channel-description" rows="3" placeholder="Описание канала"></textarea></div><div class="formgrid"><div class="field"><label>Аватар (полный путь)</label><input class="input" id="cf-channel-avatar" placeholder="C:\\Images\\avatar.png"></div><div class="field"><label>Баннер (полный путь)</label><input class="input" id="cf-channel-banner" placeholder="C:\\Images\\banner.png"></div></div><div class="field"><label>Ссылки: название | URL, по одной в строке</label><textarea class="input" id="cf-channel-links" rows="3" placeholder="Telegram | https://t.me/example"></textarea></div><button class="btn green" id="cf-channel-create">Создать задачу оформления</button><small id="cf-channel-message" style="display:block;margin-top:8px"></small>';
  const profileSelect = panel.querySelector('#cf-channel-profile');
  const loadProfiles = async () => { try { const data = await api('/api/profiles'); const profiles = data.data || data.profiles || data.items || []; profileSelect.innerHTML = profiles.length ? profiles.map(profile => `<option value="${escapeHtml(profile.id || profile.uuid)}">${escapeHtml(profile.name || profile.title || profile.id || profile.uuid)}</option>`).join('') : '<option value="">Профили не найдены</option>'; } catch (error) { profileSelect.innerHTML = '<option value="">Dolphin недоступен</option>'; } };
  const refreshTasks = async () => { const target = page.querySelector('#cf-channel-tasks'); try { const data = await api('/api/channels/tasks'); const tasks = data.tasks || []; target.innerHTML = tasks.length ? tasks.map(task => `<div class="task"><span class="num">◉</span><span><b>${escapeHtml(task.name || 'Оформление канала')}</b><br><small>${escapeHtml(task.profileId)} · ${escapeHtml(task.status)}</small></span><button class="btn ${task.status === 'completed' ? '' : 'green'}" data-channel-run="${escapeHtml(task.id)}" ${task.status === 'completed' ? 'disabled' : ''}>${task.status === 'completed' ? 'Готово' : 'Применить'}</button></div>`).join('') : '<div class="empty">Задач оформления пока нет</div>'; target.querySelectorAll('[data-channel-run]').forEach(item => item.onclick = async () => { item.disabled = true; item.textContent = '…'; try { await api(`/api/channels/tasks/${item.dataset.channelRun}/run`, { method: 'POST' }); await refreshTasks(); } catch (error) { item.textContent = error.message; } }); } catch (error) { target.textContent = error.message; } };
  const syncChannel = async restart => { const note = panel.querySelector('#cf-channel-identity'); note.textContent = restart ? 'Перезапускаю профиль с Automation API и читаю YouTube Studio…' : 'Читаю YouTube Studio в выбранном профиле…'; try { const result = await api(`/api/profiles/${encodeURIComponent(profileSelect.value)}/youtube-status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restart }) }); const channel = result.channel; if (channel.status === 'connected') { note.textContent = `Подключён канал: ${channel.channelName} · ${channel.url}`; } else if (channel.status === 'manual-login-required') { note.textContent = 'YouTube просит выполнить вход в окне Dolphin.'; } else { note.textContent = 'Dolphin не выдал адрес автоматизации для этого профиля.'; } } catch (error) { note.textContent = error.message; if (error.message.includes('уже запущен')) { const restartButton = document.createElement('button'); restartButton.className = 'btn'; restartButton.style.marginTop = '8px'; restartButton.textContent = 'Перезапустить и считать'; restartButton.onclick = () => syncChannel(true); note.after(restartButton); } } };
  panel.querySelector('#cf-channel-sync').onclick = () => syncChannel(false);
  panel.querySelector('#cf-channel-create').onclick = async () => { const rawLinks = panel.querySelector('#cf-channel-links').value.split(/\r?\n/).map(line => line.split('|').map(value => value.trim())).filter(parts => parts[0] && parts[1]).map(([title, url]) => ({ title, url })); const body = { profileId: profileSelect.value, name: panel.querySelector('#cf-channel-name').value.trim(), description: panel.querySelector('#cf-channel-description').value.trim(), avatarPath: panel.querySelector('#cf-channel-avatar').value.trim(), bannerPath: panel.querySelector('#cf-channel-banner').value.trim(), links: rawLinks }; try { await api('/api/channels/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); panel.querySelector('#cf-channel-message').textContent = 'Задача добавлена. Нажмите «Применить», чтобы изменить выбранный канал.'; await refreshTasks(); } catch (error) { panel.querySelector('#cf-channel-message').textContent = error.message; } };
  loadProfiles(); refreshTasks();
}

function enhanceOperations() {
  const settings = document.querySelector('#settings .card');
  if (!settings || document.querySelector('#cf-ops')) return;
  const panel = document.createElement('div'); panel.id = 'cf-ops'; panel.className = 'field';
  panel.innerHTML = '<h2>Прокси и журнал</h2><p class="hint">Прокси хранятся локально; пароли не выводятся в списке.</p><textarea id="cf-proxy-input" class="input" rows="4" placeholder="host:port\nhost:port:login:password"></textarea><div class="row" style="margin-top:8px"><select id="cf-proxy-type" class="input"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select><button id="cf-proxy-save" class="btn">Импортировать прокси</button></div><div id="cf-proxy-status" class="hint" style="margin-top:8px"></div><div class="field"><label>FFmpeg</label><small id="cf-ffmpeg-status">Проверка FFmpeg...</small></div><div id="cf-log-list" class="log" style="height:120px;margin-top:12px">Загрузка журнала...</div>';
  settings.appendChild(panel);
  panel.querySelector('#cf-proxy-save').onclick = async () => { const text = panel.querySelector('#cf-proxy-input').value; if (!text.trim()) return; try { const result = await api('/api/proxies/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, type: panel.querySelector('#cf-proxy-type').value }) }); panel.querySelector('#cf-proxy-input').value = ''; panel.querySelector('#cf-proxy-status').textContent = `Импортировано: ${result.imported}, ошибочных строк: ${result.invalid}`; } catch (error) { panel.querySelector('#cf-proxy-status').textContent = error.message; } };
  const loadLogs = async () => { try { const result = await api('/api/logs'); panel.querySelector('#cf-log-list').innerHTML = result.logs.length ? result.logs.map(log => `<div><b>${escapeHtml(log.level)}</b> ${escapeHtml(log.message)}</div>`).join('') : 'Журнал пуст'; } catch (error) { panel.querySelector('#cf-log-list').textContent = error.message; } };
  const loadFfmpeg = async () => { try { const health = await api('/api/uniqueizer/health'); panel.querySelector('#cf-ffmpeg-status').textContent = health.available ? `Готов: ${health.path}` : health.message; } catch (error) { panel.querySelector('#cf-ffmpeg-status').textContent = error.message; } };
  loadLogs(); loadFfmpeg(); setInterval(loadLogs, 5000);
}

function enhanceUniqueizer() {
  const card = document.querySelector('#editor .layout .card');
  if (!card || document.querySelector('#cf-unique-settings')) return;
  const section = document.createElement('div'); section.id = 'cf-unique-settings'; section.className = 'field';
  section.innerHTML = '<h2>Вариативность обработки</h2><p class="hint">Настройки применяются только к добавленным вами исходным роликам.</p><div class="field"><label>Количество вариантов: <b id="cf-variants-value">3</b></label><input type="range" id="cf-variants" min="1" max="20" value="3"></div><div class="field"><label>Папка с музыкой (необязательно)</label><input class="input" id="cf-music-path" placeholder="C:\\CreatorFlow\\music"></div><div class="field"><label>Громкость музыки: <b id="cf-volume-value">0.03</b></label><input type="range" id="cf-volume" min="0" max="0.2" step="0.01" value="0.03"></div><div class="formgrid"><div class="field"><label>Скорость минимум: <b id="cf-speed-low-value">1.00x</b></label><input type="range" id="cf-speed-low" min="0.8" max="1.3" step="0.01" value="1"></div><div class="field"><label>Скорость максимум: <b id="cf-speed-high-value">1.30x</b></label><input type="range" id="cf-speed-high" min="0.8" max="1.3" step="0.01" value="1.3"></div></div>';
  card.appendChild(section);
  const bind = (id, output, suffix = '') => { const input = section.querySelector(`#${id}`); const label = section.querySelector(`#${output}`); input.oninput = () => { label.textContent = input.value + suffix; }; };
  bind('cf-variants', 'cf-variants-value'); bind('cf-volume', 'cf-volume-value'); bind('cf-speed-low', 'cf-speed-low-value', 'x'); bind('cf-speed-high', 'cf-speed-high-value', 'x');
}

function enhanceAnalytics() {
  const page = document.querySelector('#analytics');
  if (!page || document.querySelector('#cf-analytics-extra')) return;
  const card = document.createElement('div'); card.id = 'cf-analytics-extra'; card.className = 'card'; card.style.marginTop = '18px';
  card.innerHTML = '<h2>Детализация выборки</h2><div class="stats" style="margin-top:14px"><div class="stat"><b>55</b><span>нулевых просмотров</span></div><div class="stat"><b style="color:var(--green)">40</b><span>300+ просмотров</span></div><div class="stat"><b style="color:var(--red)">83</b><span>недоступных</span></div><div class="stat"><b>0</b><span>с пометкой 18+</span></div></div><div class="row" style="margin-top:16px"><button class="btn green">Обновить статистику</button><button class="btn danger">Удалить недоступные</button></div>';
  page.appendChild(card);
}

async function refreshAnalyticsData() {
  try {
    const stats = await api('/api/videos/stats');
    const values = document.querySelectorAll('#analytics .stats .metric b');
    [stats.count, stats.views, stats.likes, stats.comments].forEach((value, index) => { if (values[index]) values[index].textContent = Number(value || 0).toLocaleString('ru-RU'); });
    const summary = document.querySelector('#analytics .layout .card .queue');
    if (summary) summary.innerHTML = `<div class="task"><span>Нулевые просмотры</span><b>${stats.zeroViews}</b></div><div class="task"><span>Ролики с 300+ просмотрами</span><b style="color:var(--green)">${stats.over300}</b></div><div class="task"><span>Недоступные позиции</span><b style="color:var(--red)">${stats.unavailable}</b></div>`;
    const videos = await api('/api/videos');
    const list = document.querySelector('#analytics .layout .card .list');
    if (list) list.innerHTML = videos.videos.length ? videos.videos.slice().sort((a, b) => Number(b.views || 0) - Number(a.views || 0)).slice(0, 5).map(video => `<div class="item"><div class="thumb"></div><span><b>${escapeHtml(video.title)}</b><small>${escapeHtml(video.profileId)}</small></span><span class="numbers"><b>${Number(video.views || 0).toLocaleString('ru-RU')}</b><br>просмотров</span></div>`).join('') : '<div class="empty">Данные публикаций ещё не синхронизированы</div>';
  } catch {}
}
