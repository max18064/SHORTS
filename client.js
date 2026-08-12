const api = async (url, options) => { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || data.message || 'Ошибка API'); return data; };
async function refreshCreatorFlow(){ const settings=document.querySelector('#settings .card'); if(!settings||document.querySelector('#cf-api-panel')) return; const panel=document.createElement('div'); panel.id='cf-api-panel'; panel.className='field'; panel.innerHTML='<label>Управление Dolphin</label><div class="row"><select class="input" id="cf-profile"><option>Загрузка профилей...</option></select><button class="btn" id="cf-profile-refresh">Обновить</button></div><div class="row" style="margin-top:8px"><button class="btn green" id="cf-profile-start">Запустить</button><button class="btn danger" id="cf-profile-stop">Остановить</button></div><small id="cf-profile-status">Ожидание подключения</small>'; settings.appendChild(panel); const select=panel.querySelector('#cf-profile'), status=panel.querySelector('#cf-profile-status'); const load=async()=>{try{const payload=await api('/api/profiles');const profiles=payload.data||payload.profiles||payload.items||[];select.innerHTML=profiles.length?profiles.map(p=>`<option value="${p.id||p.uuid}">${p.name||p.title||p.id||p.uuid}</option>`).join(''):'<option value="">Профили не найдены</option>';status.textContent=`Профилей получено: ${profiles.length}`;}catch(e){select.innerHTML='<option value="">Dolphin недоступен</option>';status.textContent=e.message;}}; panel.querySelector('#cf-profile-refresh').onclick=load; panel.querySelector('#cf-profile-start').onclick=async()=>{if(!select.value)return;status.textContent='Запуск профиля...';try{await api(`/api/profiles/${encodeURIComponent(select.value)}/start`,{method:'POST'});status.textContent='Профиль запущен';}catch(e){status.textContent=e.message;}}; panel.querySelector('#cf-profile-stop').onclick=async()=>{if(!select.value)return;status.textContent='Остановка профиля...';try{await api(`/api/profiles/${encodeURIComponent(select.value)}/stop`,{method:'POST'});status.textContent='Профиль остановлен';}catch(e){status.textContent=e.message;}}; await load(); }
document.addEventListener('DOMContentLoaded',refreshCreatorFlow);

async function refreshQueue() {
  const target = document.querySelector('#full-queue');
  if (!target) return;
  try {
    const payload = await api('/api/tasks');
    const tasks = payload.tasks || [];
    if (!tasks.length) { target.innerHTML = '<div class="empty">Очередь пока пуста</div>'; return; }
    target.innerHTML = tasks.map((task, index) => `<div class="task"><span class="num">${String(index + 1).padStart(2, '0')}</span><span><b>${task.title}</b><br><small>${task.status} · ${task.profileId}</small></span><span><span class="pill ${task.status === 'queued' ? 'wait' : ''}">${task.status}</span><br><button class="btn" data-run-task="${task.id}" data-action="run" style="padding:4px 7px;margin-top:5px">Профиль</button>${task.status === 'profile-ready' ? `<button class="btn green" data-run-task="${task.id}" data-action="upload" style="padding:4px 7px;margin-top:5px">Загрузить</button>` : ''}</span></div>`).join('');
    target.querySelectorAll('[data-run-task]').forEach(button => { button.onclick = async () => { button.disabled = true; button.textContent = '...'; try { const endpoint = button.dataset.action === 'upload' ? `/api/tasks/${button.dataset.runTask}/upload` : `/api/tasks/${button.dataset.runTask}/run`; await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await refreshQueue(); } catch (error) { button.disabled = false; button.textContent = error.message; } }; });
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
});

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
  } catch {}
}
