const jsonHeaders = token => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`
});

export function createDolphinClient({ baseUrl, token, automation = true }) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  async function request(path, options = {}) {
    if (!token) throw new Error('Ключ Dolphin API не настроен локально.');
    if (!normalizedBaseUrl) throw new Error('Адрес Dolphin API не настроен локально.');
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      ...options,
      headers: { ...jsonHeaders(token), ...(options.headers || {}) }
    });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) throw new Error(data.message || data.error || `Dolphin API ${response.status}`);
    return data;
  }
  return {
    listProfiles: () => request('/browser_profiles?limit=100'),
    listFolders: () => request('/folders?limit=100'),
    createFolder: payload => request('/folders', { method: 'POST', body: JSON.stringify(payload) }),
    fingerprint: ({ platform, browserType = 'anty', browserVersion }) => {
      const query = new URLSearchParams({ platform, browser_type: browserType });
      if (browserVersion !== undefined && browserVersion !== null && browserVersion !== '') query.set('browser_version', String(browserVersion));
      return request(`/fingerprints/fingerprint?${query.toString()}`);
    },
    createProfile: payload => request('/browser_profiles', { method: 'POST', body: JSON.stringify(payload) }),
    startProfile: id => request(`/browser_profiles/${encodeURIComponent(id)}/start${automation ? '?automation=1' : ''}`),
    stopProfile: id => request(`/browser_profiles/${encodeURIComponent(id)}/stop`),
    profile: id => request(`/browser_profiles/${encodeURIComponent(id)}`),
    request
  };
}
