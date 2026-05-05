const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore, writeStore } = require('../storage');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const store = readStore();
  res.json(store.config);
});

router.post('/', requireAuth, (req, res) => {
  const { probeTimeoutMs, pollIntervalMs, proxies, alertWebhookUrl, alertThreshold } = req.body;
  const store = readStore();
  const updated = { ...store.config };
  const errors = [];

  if (probeTimeoutMs !== undefined) {
    if (
      typeof probeTimeoutMs !== 'number' ||
      !Number.isInteger(probeTimeoutMs) ||
      probeTimeoutMs < 500 ||
      probeTimeoutMs > 10000
    ) {
      errors.push('probeTimeoutMs must be an integer between 500 and 10000');
    } else {
      updated.probeTimeoutMs = probeTimeoutMs;
    }
  }

  if (pollIntervalMs !== undefined) {
    if (
      typeof pollIntervalMs !== 'number' ||
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < 60000 ||
      pollIntervalMs > 86400000
    ) {
      errors.push('pollIntervalMs must be an integer between 60000 (1 min) and 86400000 (24 h)');
    } else {
      updated.pollIntervalMs = pollIntervalMs;
    }
  }

  if (proxies !== undefined) {
    if (!Array.isArray(proxies)) {
      errors.push('proxies must be an array of URL strings');
    } else {
      const invalid = [];
      for (const p of proxies) {
        if (typeof p !== 'string' || p.trim() === '') {
          invalid.push(String(p));
          continue;
        }
        try {
          const u = new URL(p.trim());
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
          invalid.push(p);
        }
      }
      if (invalid.length) {
        errors.push(`Invalid proxy URLs (must be http:// or https://): ${invalid.join(', ')}`);
      } else {
        updated.proxies = proxies.map((p) => p.trim());
      }
    }
  }

  if (alertWebhookUrl !== undefined) {
    if (alertWebhookUrl !== '' && alertWebhookUrl !== null) {
      try {
        const u = new URL(alertWebhookUrl);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch {
        errors.push('alertWebhookUrl must be a valid http:// or https:// URL, or empty to disable');
      }
    }
    if (!errors.some((e) => e.includes('alertWebhookUrl'))) {
      updated.alertWebhookUrl = alertWebhookUrl || null;
    }
  }

  if (alertThreshold !== undefined) {
    if (
      typeof alertThreshold !== 'number' ||
      !Number.isInteger(alertThreshold) ||
      alertThreshold < 1 ||
      alertThreshold > 20
    ) {
      errors.push('alertThreshold must be an integer between 1 and 20');
    } else {
      updated.alertThreshold = alertThreshold;
    }
  }

  const { blockPatterns } = req.body;

  if (blockPatterns !== undefined) {
    if (!Array.isArray(blockPatterns)) {
      errors.push('blockPatterns must be an array of strings');
    } else {
      const invalid = [];
      for (const p of blockPatterns) {
        if (typeof p !== 'string' || p.trim() === '') {
          invalid.push(`"${p}" (empty or not a string)`);
          continue;
        }
        try { new RegExp(p); } catch {
          invalid.push(`"${p}" (invalid regex)`);
        }
      }
      if (invalid.length) {
        errors.push(`Invalid patterns: ${invalid.join(', ')}`);
      } else {
        updated.blockPatterns = blockPatterns.map((p) => p.trim());
      }
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  updated.updatedAt = new Date().toISOString();
  store.config = updated;

  const parts = [];
  if (probeTimeoutMs !== undefined) parts.push(`probeTimeoutMs=${probeTimeoutMs}ms`);
  if (pollIntervalMs !== undefined) parts.push(`pollIntervalMs=${pollIntervalMs}ms`);
  if (proxies !== undefined) parts.push(`proxies updated (${proxies.length} proxy/proxies)`);
  if (alertWebhookUrl !== undefined) parts.push(`alertWebhookUrl=${alertWebhookUrl || 'cleared'}`);
  if (alertThreshold !== undefined) parts.push(`alertThreshold=${alertThreshold}`);
  if (blockPatterns !== undefined) parts.push(`blockPatterns updated (${blockPatterns.length} patterns)`);

  const entry = {
    action: 'config_updated',
    detail: parts.join('; '),
    setAt: new Date().toISOString(),
    setBy: 'admin',
  };
  store.history = [entry, ...store.history].slice(0, 50);

  writeStore(store);
  res.json(store.config);
});

module.exports = router;
