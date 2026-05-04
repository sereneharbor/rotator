const express = require('express');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');

const router = express.Router();

// Public or admin — returns enabled mirrors (public) or full list (admin)
router.get('/', (req, res) => {
  const store = readStore();

  // If a valid bearer token is present, return the full admin list
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      return res.json(store.mirrors);
    } catch {
      // fall through to public response
    }
  }

  // Public response: enabled only, id + url, no labels
  const enabled = store.mirrors
    .filter((m) => m.enabled)
    .map(({ id, url }) => ({ id, url }));
  // Expose the configured probe timeout so the controller can use it without auth
  res.set('X-Probe-Timeout-Ms', String(store.config.probeTimeoutMs || 3000));
  res.json(enabled);
});

// Protected — replaces full mirror list
router.post('/', requireAuth, (req, res) => {
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

  store.mirrors = mirrors;

  const entry = {
    action: 'mirrors_updated',
    detail,
    setAt: new Date().toISOString(),
    setBy: 'admin',
  };
  store.history = [entry, ...store.history].slice(0, 50);

  writeStore(store);

  res.json(store.mirrors);
});

module.exports = router;
