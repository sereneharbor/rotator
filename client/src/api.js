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

// Returns { mirrors, probeTimeoutMs } for the controller page.
// Sends the controller token (if configured at build time) so the server
// can restrict the public mirror list endpoint.
export async function getMirrorsWithConfig() {
  const controllerToken = import.meta.env.VITE_CONTROLLER_TOKEN;
  const headers = { ...authHeaders() };
  if (controllerToken) headers['X-Controller-Token'] = controllerToken;

  const res = await fetch(`${BASE}/mirrors`, { headers });
  const data = await res.json();
  const probeTimeoutMs = parseInt(res.headers.get('X-Probe-Timeout-Ms') || '7000', 10);
  return { mirrors: data, probeTimeoutMs };
}

export const api = {
  login: (password) => request('POST', '/login', { password }),
  getMirrors: () => request('GET', '/mirrors'),
  saveMirrors: (mirrors) => request('POST', '/mirrors', mirrors),
  getConfig: () => request('GET', '/config'),
  saveConfig: (config) => request('POST', '/config', config),
  getHistory: () => request('GET', '/history'),
  getLog: () => request('GET', '/log'),
  probeAll: () => request('POST', '/probe'),
  saveBlockPatterns: (blockPatterns) => request('POST', '/config', { blockPatterns }),
  getPollStatus: () => request('GET', '/poll'),
  triggerPoll: () => request('POST', '/poll'),
};
