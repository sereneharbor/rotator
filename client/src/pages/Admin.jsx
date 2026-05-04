import { useState, useEffect, useCallback, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api.js';

// ─── Token helpers ───────────────────────────────────────────────────────────

function getToken() {
  return sessionStorage.getItem('admin_token');
}

function setToken(t) {
  sessionStorage.setItem('admin_token', t);
}

function clearToken() {
  sessionStorage.removeItem('admin_token');
}

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Date.now() / 1000 > payload.exp;
  } catch {
    return true;
  }
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.login(password);
      setToken(token);
      onLogin();
    } catch (err) {
      setError(err.message || 'Invalid password');
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-white text-2xl font-bold mb-8 text-center">Admin Login</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`w-full px-4 py-3 rounded-lg bg-gray-800 text-white placeholder-gray-500 border border-gray-700 focus:outline-none focus:border-blue-500 ${shaking ? 'shake' : ''}`}
            autoFocus
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <a href="/" className="block mt-6 text-center text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; Back to site
        </a>
      </div>
    </div>
  );
}

// ─── Sortable Mirror Row ──────────────────────────────────────────────────────

function SortableMirrorRow({ mirror, onToggle, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: mirror.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-3"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="text-gray-500 hover:text-gray-300 cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="4" r="1.5" />
          <circle cx="11" cy="4" r="1.5" />
          <circle cx="5" cy="8" r="1.5" />
          <circle cx="11" cy="8" r="1.5" />
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="11" cy="12" r="1.5" />
        </svg>
      </button>

      {/* Label + URL */}
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{mirror.label || '(no label)'}</p>
        <p className="text-gray-400 text-xs truncate">{mirror.url}</p>
      </div>

      {/* Enabled toggle */}
      <button
        onClick={() => onToggle(mirror.id)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${mirror.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
        role="switch"
        aria-checked={mirror.enabled}
        aria-label={mirror.enabled ? 'Disable mirror' : 'Enable mirror'}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${mirror.enabled ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </button>

      {/* Delete */}
      <button
        onClick={() => onDelete(mirror.id)}
        className="text-gray-500 hover:text-red-400 transition-colors"
        aria-label="Delete mirror"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
      </button>
    </div>
  );
}

// ─── Mirror Manager Section ───────────────────────────────────────────────────

function MirrorManager({ onSaved }) {
  const [mirrors, setMirrors] = useState(null);
  const [staged, setStaged] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState('');
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | saved | error
  const [saveError, setSaveError] = useState('');
  const saveTimer = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    loadMirrors();
  }, []);

  async function loadMirrors() {
    try {
      // GET /api/mirrors returns the full list (with labels + disabled) when
      // a valid Bearer token is present; the public response strips that data.
      const full = await api.getMirrors();
      setMirrors(full);
      setStaged(full);
    } catch {
      setMirrors([]);
      setStaged([]);
    }
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setStaged((prev) => {
        const oldIndex = prev.findIndex((m) => m.id === active.id);
        const newIndex = prev.findIndex((m) => m.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }

  function handleToggle(id) {
    setStaged((prev) =>
      prev.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m))
    );
  }

  function handleDelete(id) {
    setStaged((prev) => prev.filter((m) => m.id !== id));
  }

  function handleAddSubmit(e) {
    e.preventDefault();
    setAddError('');
    const trimmedUrl = newUrl.trim();
    if (!trimmedUrl.startsWith('https://')) {
      setAddError('URL must start with https://');
      return;
    }
    try {
      new URL(trimmedUrl);
    } catch {
      setAddError('Invalid URL');
      return;
    }
    const id = 'm' + Date.now();
    const mirror = { id, url: trimmedUrl, label: newLabel.trim() || trimmedUrl, enabled: true };
    setStaged((prev) => [...prev, mirror]);
    setNewUrl('');
    setNewLabel('');
    setShowAddForm(false);
  }

  async function handleSaveAll() {
    setSaveStatus('saving');
    setSaveError('');
    try {
      const saved = await api.saveMirrors(staged);
      setMirrors(saved);
      setStaged(saved);
      setSaveStatus('saved');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveStatus('idle'), 3000);
      if (onSaved) onSaved();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err.message);
    }
  }

  if (mirrors === null) {
    return <div className="text-gray-400 text-sm">Loading mirrors…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-lg">Mirror List</h2>
        <button
          onClick={() => { setShowAddForm(true); setAddError(''); }}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          + Add Mirror
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAddSubmit} className="flex flex-col gap-3 bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h3 className="text-white text-sm font-medium">New Mirror</h3>
          <input
            type="url"
            placeholder="https://mirror.example.com"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="px-3 py-2 rounded bg-gray-900 text-white text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <input
            type="text"
            placeholder="Label (e.g. Primary)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="px-3 py-2 rounded bg-gray-900 text-white text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
          />
          {addError && <p className="text-red-400 text-xs">{addError}</p>}
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">
              Save
            </button>
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setNewUrl(''); setNewLabel(''); setAddError(''); }}
              className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {staged.length === 0 ? (
        <p className="text-gray-500 text-sm">No mirrors configured. Add one above.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={staged.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {staged.map((mirror) => (
                <SortableMirrorRow
                  key={mirror.id}
                  mirror={mirror}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSaveAll}
          disabled={saveStatus === 'saving'}
          className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {saveStatus === 'saving' ? 'Saving…' : 'Save All Changes'}
        </button>
        {saveStatus === 'saved' && (
          <span className="text-green-400 text-sm">&#10003; Saved</span>
        )}
        {saveStatus === 'error' && (
          <span className="text-red-400 text-sm">{saveError}</span>
        )}
      </div>
    </div>
  );
}

// ─── Timeout Config Section ───────────────────────────────────────────────────

function TimeoutConfig({ onSaved }) {
  const [value, setValue] = useState('');
  const [saveStatus, setSaveStatus] = useState('idle');
  const [error, setError] = useState('');
  const saveTimer = useRef(null);

  useEffect(() => {
    api.getConfig()
      .then((cfg) => setValue(String(cfg.probeTimeoutMs)))
      .catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms < 500 || ms > 10000) {
      setError('Value must be between 500 and 10000');
      return;
    }
    setSaveStatus('saving');
    try {
      await api.saveConfig(ms);
      setSaveStatus('saved');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveStatus('idle'), 3000);
      if (onSaved) onSaved();
    } catch (err) {
      setSaveStatus('error');
      setError(err.message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-white font-semibold text-lg">Timeout Configuration</h2>
      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <div>
          <label className="block text-gray-300 text-sm mb-1.5">Probe timeout (ms)</label>
          <input
            type="number"
            min="500"
            max="10000"
            step="100"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); setSaveStatus('idle'); }}
            className="w-48 px-3 py-2 rounded bg-gray-800 text-white text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
          />
          <p className="text-gray-500 text-xs mt-1.5">
            How long to wait for each mirror before treating it as blocked by an ISP.
          </p>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saveStatus === 'saving'}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {saveStatus === 'saved' && (
            <span className="text-green-400 text-sm">&#10003; Saved</span>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── History Section ──────────────────────────────────────────────────────────

function HistoryLog({ refreshKey }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    api.getHistory()
      .then(setHistory)
      .catch(() => {});
  }, [refreshKey]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-white font-semibold text-lg">Change History</h2>
      {history.length === 0 ? (
        <p className="text-gray-500 text-sm">No changes recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-2 pr-4 font-medium">Action</th>
                <th className="pb-2 pr-4 font-medium">Detail</th>
                <th className="pb-2 font-medium whitespace-nowrap">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, i) => (
                <tr key={i} className="border-b border-gray-800 last:border-0">
                  <td className="py-2 pr-4 text-gray-300 whitespace-nowrap">{entry.action}</td>
                  <td className="py-2 pr-4 text-gray-400">{entry.detail}</td>
                  <td className="py-2 text-gray-500 whitespace-nowrap">
                    {new Date(entry.setAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Redirect Log Section ────────────────────────────────────────────────────

function RedirectLog() {
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const data = await api.getLog();
      setLog(data);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-lg">Redirect Log</h2>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 rounded-lg transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p className="text-gray-500 text-xs">
        One entry per visitor. Newest first. Capped at 500 entries.
      </p>

      {loading && log.length === 0 ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : log.length === 0 ? (
        <p className="text-gray-500 text-sm">No redirect attempts recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-2 pr-3 font-medium whitespace-nowrap">Timestamp</th>
                <th className="pb-2 pr-3 font-medium">IP</th>
                <th className="pb-2 pr-3 font-medium">Result</th>
                <th className="pb-2 pr-3 font-medium">Redirected To</th>
                <th className="pb-2 font-medium">Entry Params</th>
              </tr>
            </thead>
            <tbody>
              {log.map((entry, i) => (
                <tr key={i} className="border-b border-gray-800 last:border-0 align-top">
                  <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                    {new Date(entry.timestamp).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-gray-400 font-mono whitespace-nowrap">
                    {entry.ip}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {entry.result === 'redirected' ? (
                      <span className="text-green-400">&#10003; redirected</span>
                    ) : (
                      <span className="text-red-400">&#10007; all failed</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-gray-400 max-w-xs truncate">
                    {entry.redirectedTo ? (
                      <span title={entry.redirectedTo} className="font-mono">
                        {new URL(entry.redirectedTo).hostname}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-2 text-gray-500 font-mono max-w-xs truncate">
                    {entry.entryParams || <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ onLogout }) {
  const [historyKey, setHistoryKey] = useState(0);
  const siteName = import.meta.env.VITE_SITE_NAME || 'Mirror Rotator';

  function refreshHistory() {
    setHistoryKey((k) => k + 1);
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <span className="font-bold text-lg">{siteName}</span>
          <span className="ml-2 text-gray-400 text-sm">Admin Panel</span>
        </div>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
        >
          Logout
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 flex flex-col gap-10">
        {/* Section 1 */}
        <section className="bg-gray-900 rounded-xl p-6">
          <MirrorManager onSaved={refreshHistory} />
        </section>

        {/* Section 2 */}
        <section className="bg-gray-900 rounded-xl p-6">
          <TimeoutConfig onSaved={refreshHistory} />
        </section>

        {/* Section 3 */}
        <section className="bg-gray-900 rounded-xl p-6">
          <HistoryLog refreshKey={historyKey} />
        </section>

        {/* Section 4 */}
        <section className="bg-gray-900 rounded-xl p-6">
          <RedirectLog />
        </section>
      </main>
    </div>
  );
}

// ─── Admin Page Root ─────────────────────────────────────────────────────────

export default function Admin() {
  const [authed, setAuthed] = useState(() => {
    const token = getToken();
    return !!token && !isTokenExpired(token);
  });

  function handleLogin() {
    setAuthed(true);
  }

  function handleLogout() {
    clearToken();
    window.location.href = '/';
  }

  if (!authed) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}
