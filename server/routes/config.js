const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const store = readStore();
  res.json(store.config);
});

router.post('/', requireAuth, (req, res) => {
  const { probeTimeoutMs } = req.body;

  if (
    typeof probeTimeoutMs !== 'number' ||
    !Number.isInteger(probeTimeoutMs) ||
    probeTimeoutMs < 500 ||
    probeTimeoutMs > 10000
  ) {
    return res.status(400).json({ error: 'probeTimeoutMs must be between 500 and 10000' });
  }

  const store = readStore();
  store.config = {
    probeTimeoutMs,
    updatedAt: new Date().toISOString(),
  };

  const entry = {
    action: 'config_updated',
    detail: `probeTimeoutMs set to ${probeTimeoutMs}ms`,
    setAt: new Date().toISOString(),
    setBy: 'admin',
  };
  store.history = [entry, ...store.history].slice(0, 50);

  writeStore(store);

  res.json(store.config);
});

module.exports = router;
