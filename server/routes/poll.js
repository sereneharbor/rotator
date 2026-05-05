/**
 * POST /api/poll  — trigger an immediate poll (admin only)
 * GET  /api/poll  — get current poll status and summary (admin only)
 */

const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore } = require('../storage');
const { triggerPoll, getPollIsRunning } = require('../scheduler');

const router = express.Router();

// GET /api/poll — poll status
router.get('/', requireAuth, (req, res) => {
  const store = readStore();
  const enabled = store.mirrors.filter((m) => m.enabled);
  const preValidated = enabled.filter((m) => m.preValidated === true);

  res.json({
    isRunning: getPollIsRunning(),
    lastPollAt: store.config.lastPollAt || null,
    nextPollAt: store.config.nextPollAt || null,
    pollIntervalMs: store.config.pollIntervalMs || 1800000,
    proxies: store.config.proxies || [],
    summary: {
      total: enabled.length,
      preValidated: preValidated.length,
    },
  });
});

// POST /api/poll — trigger immediate poll (synchronous — waits for completion)
router.post('/', requireAuth, async (req, res) => {
  if (getPollIsRunning()) {
    return res.status(409).json({ error: 'Poll already in progress' });
  }

  await triggerPoll();

  const store = readStore();
  const enabled = store.mirrors.filter((m) => m.enabled);
  const preValidated = enabled.filter((m) => m.preValidated === true);

  res.json({
    lastPollAt: store.config.lastPollAt,
    nextPollAt: store.config.nextPollAt,
    summary: {
      total: enabled.length,
      preValidated: preValidated.length,
    },
  });
});

module.exports = router;
