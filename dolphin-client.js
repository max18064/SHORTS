const jsonHeaders = token => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`
});

export function createDolphinClient({ baseUrl, token, automation = true }) {
  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
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
    startProfile: id => request(`/browser_profiles/${encodeURIComponent(id)}/start${automation ? '?automation=1' : ''}`),
    stopProfile: id => request(`/browser_profiles/${encodeURIComponent(id)}/stop`),
    profile: id => request(`/browser_profiles/${encodeURIComponent(id)}`),
    request
  };
}
