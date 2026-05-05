const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');

const router = express.Router();

const MAX_LOG_ENTRIES = 500;

// Public — called by the redirect controller (fire-and-forget, keepalive)
router.post('/', (req, res) => {
  const { result, redirectedTo, mirrorId, entryParams, mirrorResults } = req.body;

  if (!result || !['redirected', 'all_failed'].includes(result)) {
    return res.status(400).json({ error: 'Invalid result value' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  // Sanitise mirrorResults: keep only expected fields, cap array length
  const sanitisedResults = Array.isArray(mirrorResults)
    ? mirrorResults.slice(0, 30).map((r) => ({
        id: r.id || null,
        url: r.url || null,
        healthy: !!r.healthy,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : null,
      }))
    : [];

  const entry = {
    timestamp: new Date().toISOString(),
    ip,
    userAgent: req.headers['user-agent'] || 'unknown',
    result,
    redirectedTo: redirectedTo || null,
    mirrorId: mirrorId || null,
    entryParams: entryParams || '',
    mirrorResults: sanitisedResults,
  };

  const store = readStore();
  if (!store.redirectLog) store.redirectLog = [];
  store.redirectLog = [entry, ...store.redirectLog].slice(0, MAX_LOG_ENTRIES);
  writeStore(store);

  res.status(204).end();
});

// Protected — admin view
router.get('/', requireAuth, (req, res) => {
  const store = readStore();
  res.json(store.redirectLog || []);
});

module.exports = router;
