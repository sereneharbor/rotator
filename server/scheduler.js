/**
 * Background poll scheduler.
 *
 * Every pollIntervalMs (default 30 minutes), probes all enabled mirrors
 * through the configured proxy list. Results update the preValidated flag
 * on each mirror — only pre-validated mirrors are served to visitors via
 * GET /api/mirrors.
 *
 * The scheduler reschedules itself after each run so that interval changes
 * made via the admin panel take effect on the next cycle.
 */

const { readStore, writeStore } = require('./storage');
const { probeAllWithProxies } = require('./probe');
const { checkAndAlert } = require('./alerts');

let timer = null;
let isRunning = false;

/**
 * Execute one poll cycle: probe all enabled mirrors through configured proxies
 * and update preValidated status in storage.
 */
async function runPoll() {
  if (isRunning) {
    console.log('[scheduler] Poll already running, skipping');
    return;
  }
  isRunning = true;
  console.log('[scheduler] Starting poll cycle');

  try {
    const store = readStore();
    const proxies = store.config.proxies || [];
    const enabledMirrors = store.mirrors.filter((m) => m.enabled);

    if (enabledMirrors.length === 0) {
      console.log('[scheduler] No enabled mirrors to poll');
      return;
    }

    if (proxies.length > 0) {
      console.log(`[scheduler] Probing ${enabledMirrors.length} mirror(s) through ${proxies.length} proxy/proxies`);
    } else {
      console.log(`[scheduler] Probing ${enabledMirrors.length} mirror(s) directly (no proxies configured)`);
    }

    const results = await probeAllWithProxies(enabledMirrors, proxies);
    const resultMap = new Map(results.map((r) => [r.id, r]));
    const now = new Date().toISOString();

    const healthy = results.filter((r) => r.status === 'healthy').length;
    console.log(`[scheduler] Poll complete: ${healthy}/${results.length} healthy`);

    // Re-read store before writing to avoid overwriting concurrent changes
    const fresh = readStore();
    fresh.mirrors = fresh.mirrors.map((m) => {
      const r = resultMap.get(m.id);
      if (!r) return m;
      return {
        ...m,
        preValidated: r.status === 'healthy',
        preValidatedAt: now,
        pollStatus: r.status,
        pollReason: r.reason || null,
        pollProxy: r.proxyUsed || null,
      };
    });

    fresh.config.lastPollAt = now;
    writeStore(fresh);
    checkAndAlert(fresh);
  } catch (err) {
    console.error('[scheduler] Poll error:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Schedule the next poll at the configured interval.
 * Always reads interval fresh from store so admin changes take effect.
 */
function reschedule() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const store = readStore();
  const interval = store.config.pollIntervalMs || 1800000;
  const nextAt = new Date(Date.now() + interval).toISOString();

  // Persist nextPollAt so the admin panel can display it
  const fresh = readStore();
  fresh.config.nextPollAt = nextAt;
  writeStore(fresh);

  console.log(`[scheduler] Next poll in ${Math.round(interval / 60000)} minute(s) at ${nextAt}`);

  timer = setTimeout(async () => {
    await runPoll();
    reschedule();
  }, interval);
}

/**
 * Start the scheduler. Runs the first poll after a short boot delay,
 * then reschedules automatically.
 */
function start() {
  console.log('[scheduler] Initialising background poll scheduler');
  // Short delay to let the server fully boot before the first probe
  setTimeout(async () => {
    await runPoll();
    reschedule();
  }, 5000);
}

/**
 * Trigger an immediate poll (called by the admin "Poll Now" button).
 * Cancels any pending scheduled timer and reschedules after the poll.
 */
async function triggerPoll() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await runPoll();
  reschedule();
}

function getPollIsRunning() {
  return isRunning;
}

module.exports = { start, triggerPoll, getPollIsRunning };
