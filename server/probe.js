/**
 * Server-side mirror health probe.
 *
 * Detects:
 *   - HTTP 403 / 451 (legal/firewall block)
 *   - Block page body content (regex patterns stored in store.json, editable via admin)
 *   - Connection timeouts
 *
 * Supports optional HTTP/HTTPS proxy via undici ProxyAgent.
 */

const { ProxyAgent, fetch: undiciFetch } = require('undici');
const { readStore, DEFAULT_BLOCK_PATTERNS } = require('./storage');

const BLOCKED_STATUS_CODES = new Set([403, 451]);

const PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROBE_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 51200; // 50 KB — enough to catch a block page header

/** Build RegExp list from stored pattern strings (with isu flags). */
function getBlockPatterns() {
  try {
    const store = readStore();
    const patterns = store.config.blockPatterns;
    if (Array.isArray(patterns) && patterns.length > 0) {
      return patterns.map((p) => new RegExp(p, 'isu'));
    }
  } catch {
    // fall through
  }
  return DEFAULT_BLOCK_PATTERNS.map((p) => new RegExp(p, 'isu'));
}

/**
 * Probe a single URL, optionally through an HTTP/HTTPS proxy.
 * @param {string} url - Target mirror URL
 * @param {string|null} proxyUrl - Proxy URL e.g. 'http://user:pass@host:port', or null for direct
 * @returns {{ status, reason?, httpStatus?, matchedPattern?, proxyUsed? }}
 */
async function probeUrl(url, proxyUrl = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const options = {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': PROBE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    };

    if (proxyUrl) {
      options.dispatcher = new ProxyAgent(proxyUrl);
    }

    const res = await undiciFetch(url, options);

    if (BLOCKED_STATUS_CODES.has(res.status)) {
      return {
        status: 'blocked',
        reason: `HTTP ${res.status} response`,
        httpStatus: res.status,
        proxyUsed: proxyUrl || null,
      };
    }

    // Stream up to MAX_BODY_BYTES for content analysis
    const chunks = [];
    let bytesRead = 0;
    try {
      for await (const chunk of res.body) {
        chunks.push(chunk);
        bytesRead += chunk.length;
        if (bytesRead >= MAX_BODY_BYTES) break;
      }
    } catch {
      // non-fatal — use whatever we buffered
    }

    const bodyText = Buffer.concat(chunks).toString('utf-8');
    const patterns = getBlockPatterns();

    for (const pattern of patterns) {
      if (pattern.test(bodyText)) {
        return {
          status: 'blocked',
          reason: `Block page content matched: ${pattern.source}`,
          httpStatus: res.status,
          matchedPattern: pattern.source,
          proxyUsed: proxyUrl || null,
        };
      }
    }

    return { status: 'healthy', httpStatus: res.status, proxyUsed: proxyUrl || null };
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'ERR_ABORTED') {
      return {
        status: 'timeout',
        reason: `No response within ${PROBE_TIMEOUT_MS / 1000}s`,
        proxyUsed: proxyUrl || null,
      };
    }
    return { status: 'error', reason: err.message, proxyUsed: proxyUrl || null };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe an array of mirrors concurrently (direct, no proxy). Used by the manual Check All. */
async function probeAll(mirrors) {
  return Promise.all(
    mirrors.map(async (m) => {
      const result = await probeUrl(m.url, null);
      return { id: m.id, url: m.url, ...result };
    })
  );
}

/**
 * Probe mirrors through proxies (scheduled poll).
 * Proxies are assigned round-robin across mirrors.
 * If no proxies are configured, falls back to direct connection.
 * @param {Array} mirrors - enabled mirrors to probe
 * @param {string[]} proxies - proxy URL list
 */
async function probeAllWithProxies(mirrors, proxies = []) {
  return Promise.all(
    mirrors.map(async (m, index) => {
      const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : null;
      const result = await probeUrl(m.url, proxyUrl);
      return { id: m.id, url: m.url, ...result };
    })
  );
}

module.exports = { probeUrl, probeAll, probeAllWithProxies };
