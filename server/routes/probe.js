const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');
const { probeAll } = require('../probe');
const { checkAndAlert } = require('../alerts');

const router = express.Router();

/**
 * POST /api/probe
 * Probes all mirrors server-side (status codes + body content analysis).
 * Updates serverStatus on each mirror in storage.
 * Protected — admin only.
 */
router.post('/', requireAuth, async (req, res) => {
  const store = readStore();

  if (!store.mirrors.length) {
    return res.json([]);
  }

  const results = await probeAll(store.mirrors);
  const resultMap = new Map(results.map((r) => [r.id, r]));

  // Re-read store to avoid overwriting concurrent writes
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

  res.json(fresh.mirrors);
});

module.exports = router;
