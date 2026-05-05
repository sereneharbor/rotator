const express = require('express');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');
const { probeAll } = require('../probe');
const { checkAndAlert } = require('../alerts');

const router = express.Router();

// ─── Bot User-Agent blocklist ─────────────────────────────────────────────────

const BOT_UA_PATTERNS = [
  /^curl\//i,
  /^wget\//i,
  /python-requests/i,
  /^python\//i,
  /go-http-client/i,
  /scrapy/i,
  /mechanize/i,
  /^java\//i,
  /libwww/i,
  /lwp-/i,
  /okhttp/i,
  /apache-httpclient/i,
  /^axios\//i,
  /^node-fetch/i,
  /^got\//i,
  /^undici/i,
];

function isBotUA(ua) {
  if (!ua) return true;
  return BOT_UA_PATTERNS.some((p) => p.test(ua));
}

// ─── Controller token check ───────────────────────────────────────────────────

function hasValidControllerToken(req) {
  const required = process.env.CONTROLLER_TOKEN;
  if (!required) return true; // not configured — allow all
  return req.headers['x-controller-token'] === required;
}

// ─── GET /api/mirrors ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';

  // If a valid admin Bearer token is present, return the full list (admin view)
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      const store = readStore();
      return res.json(store.mirrors);
    } catch {
      // fall through to public response
    }
  }

  // Block bot User-Agents
  if (isBotUA(ua)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Require controller token if configured
  if (!hasValidControllerToken(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const store = readStore();

  // Public response: pre-validated mirrors only (id + url).
  // Pre-validated = passed the last scheduled proxy poll.
  // Fallback: if no poll has run yet, return all enabled mirrors so the
  // system works out of the box before the first poll completes.
  const enabledMirrors = store.mirrors.filter((m) => m.enabled);
  const preValidated = enabledMirrors.filter((m) => m.preValidated === true);
  const usingFallback = preValidated.length === 0;
  const publicList = (usingFallback ? enabledMirrors : preValidated)
    .map(({ id, url }) => ({ id, url }));

  res.set('X-Probe-Timeout-Ms', String(store.config.probeTimeoutMs || 3000));
  res.set('X-Poll-Validated', usingFallback ? 'false' : 'true');
  res.json(publicList);
});

// ─── POST /api/mirrors ────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const mirrors = req.body;

  if (!Array.isArray(mirrors)) {
    return res.status(400).json({ error: 'Body must be an array of mirrors' });
  }
  if (mirrors.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 mirrors allowed' });
  }

  const ids = mirrors.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Mirror id values must be unique' });
  }

  for (const mirror of mirrors) {
    if (!mirror.id || typeof mirror.id !== 'string') {
      return res.status(400).json({ error: 'Each mirror must have a string id' });
    }
    if (!mirror.url || typeof mirror.url !== 'string') {
      return res.status(400).json({ error: 'Each mirror must have a url' });
    }
    if (!mirror.url.startsWith('https://')) {
      return res.status(400).json({ error: `URL must use https://: ${mirror.url}` });
    }
    try {
      new URL(mirror.url);
    } catch {
      return res.status(400).json({ error: `Invalid URL: ${mirror.url}` });
    }
    if (typeof mirror.enabled !== 'boolean') {
      return res.status(400).json({ error: `Mirror ${mirror.id} must have a boolean enabled field` });
    }
  }

  const store = readStore();
  const oldUrls = store.mirrors.map((m) => m.url);
  const newUrls = mirrors.map((m) => m.url);

  const added = newUrls.filter((u) => !oldUrls.includes(u));
  const removed = oldUrls.filter((u) => !newUrls.includes(u));
  const parts = [];
  if (added.length) parts.push(`Added: ${added.map((u) => new URL(u).hostname).join(', ')}`);
  if (removed.length) parts.push(`Removed: ${removed.map((u) => new URL(u).hostname).join(', ')}`);
  const detail = parts.length ? parts.join('; ') : 'Reordered or toggled mirrors';

  // Preserve existing server probe + poll status for mirrors that already exist
  const existingStatusMap = new Map(
    store.mirrors.map((m) => [m.id, {
      serverStatus: m.serverStatus,
      serverStatusReason: m.serverStatusReason,
      serverStatusAt: m.serverStatusAt,
      preValidated: m.preValidated,
      preValidatedAt: m.preValidatedAt,
      pollStatus: m.pollStatus,
      pollReason: m.pollReason,
      pollProxy: m.pollProxy,
    }])
  );

  store.mirrors = mirrors.map((m) => ({
    serverStatus: null,
    serverStatusReason: null,
    serverStatusAt: null,
    preValidated: null,
    preValidatedAt: null,
    pollStatus: null,
    pollReason: null,
    pollProxy: null,
    ...existingStatusMap.get(m.id),
    ...m,
  }));

  const entry = {
    action: 'mirrors_updated',
    detail,
    setAt: new Date().toISOString(),
    setBy: 'admin',
  };
  store.history = [entry, ...store.history].slice(0, 50);
  writeStore(store);

  // Probe newly added mirrors in the background (fire and forget)
  const newMirrors = mirrors.filter((m) => !existingStatusMap.has(m.id));
  if (newMirrors.length) {
    probeAll(newMirrors).then((results) => {
      const resultMap = new Map(results.map((r) => [r.id, r]));
      const fresh = readStore();
      fresh.mirrors = fresh.mirrors.map((m) => {
        const r = resultMap.get(m.id);
        if (!r) return m;
        return {
          ...m,
          serverStatus: r.status,
          serverStatusReason: r.reason || null,
          serverStatusAt: new Date().toISOString(),
        };
      });
      writeStore(fresh);
      checkAndAlert(fresh);
    }).catch(() => {});
  }

  checkAndAlert(store);

  res.json(store.mirrors);
});

module.exports = router;
