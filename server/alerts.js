/**
 * Webhook alerting.
 *
 * Fires when the number of healthy, enabled mirrors drops to or below
 * the configured alertThreshold, or reaches zero.
 *
 * Webhook payload (POST, application/json):
 * {
 *   event:     'mirrors_empty' | 'mirrors_low',
 *   message:   string,
 *   available: number,   // healthy mirrors right now
 *   total:     number,   // total enabled mirrors
 *   threshold: number,   // configured alert threshold
 *   siteName:  string,
 *   timestamp: ISO string
 * }
 */

async function sendWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[alerts] Webhook returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[alerts] Webhook delivery failed:', err.message);
  }
}

/**
 * Evaluate mirror counts and fire an alert webhook if thresholds are crossed.
 * Call this after any operation that may change mirror availability.
 * @param {object} store - current full store object
 */
function checkAndAlert(store) {
  const webhookUrl = store.config.alertWebhookUrl;
  if (!webhookUrl) return;

  const threshold = store.config.alertThreshold ?? 3;
  const enabledMirrors = store.mirrors.filter((m) => m.enabled);
  const total = enabledMirrors.length;

  // Use preValidated count as the primary availability metric (set by the
  // scheduled proxy poll). Fall back to serverStatus check if no poll has run.
  const hasBeenPolled = enabledMirrors.some((m) => m.preValidated !== null && m.preValidated !== undefined);
  const available = hasBeenPolled
    ? enabledMirrors.filter((m) => m.preValidated === true).length
    : enabledMirrors.filter((m) => m.serverStatus !== 'blocked').length;

  const base = {
    available,
    total,
    threshold,
    siteName: process.env.SITE_NAME || 'Mirror Rotator',
    timestamp: new Date().toISOString(),
  };

  if (available === 0) {
    sendWebhook(webhookUrl, {
      ...base,
      event: 'mirrors_empty',
      message: 'All mirrors are unavailable — visitors cannot be redirected',
    });
  } else if (available <= threshold) {
    sendWebhook(webhookUrl, {
      ...base,
      event: 'mirrors_low',
      message: `Only ${available} of ${total} mirrors available (threshold: ${threshold})`,
    });
  }
}

module.exports = { checkAndAlert };
