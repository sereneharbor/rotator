const BASE = '/api';

function getToken() {
  return sessionStorage.getItem('admin_token');
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

// Returns { mirrors, probeTimeoutMs } for the controller page
export async function getMirrorsWithConfig() {
  const res = await fetch(`${BASE}/mirrors`, {
    headers: authHeaders(),
  });
  const data = await res.json();
  const probeTimeoutMs = parseInt(res.headers.get('X-Probe-Timeout-Ms') || '7000', 10);
  return { mirrors: data, probeTimeoutMs };
}

export const api = {
  login: (password) => request('POST', '/login', { password }),
  getMirrors: () => request('GET', '/mirrors'),
  saveMirrors: (mirrors) => request('POST', '/mirrors', mirrors),
  getConfig: () => request('GET', '/config'),
  saveConfig: (probeTimeoutMs) => request('POST', '/config', { probeTimeoutMs }),
  getHistory: () => request('GET', '/history'),
  getLog: () => request('GET', '/log'),
};
