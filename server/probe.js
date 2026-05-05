/**
 * Server-side mirror health probe.
 *
 * Detects:
 *   - HTTP 403 / 451 (legal/firewall block)
 *   - Block page body content (regex patterns stored in store.json, editable via admin)
 *   - Connection timeouts
 */

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
 * Probe a single URL from the server.
 * Returns { status, reason?, httpStatus?, matchedPattern? }
 */
async function probeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': PROBE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (BLOCKED_STATUS_CODES.has(res.status)) {
      return {
        status: 'blocked',
        reason: `HTTP ${res.status} response`,
        httpStatus: res.status,
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
        };
      }
    }

    return { status: 'healthy', httpStatus: res.status };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'timeout', reason: `No response within ${PROBE_TIMEOUT_MS / 1000}s` };
    }
    return { status: 'error', reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe an array of mirrors concurrently. */
async function probeAll(mirrors) {
  return Promise.all(
    mirrors.map(async (m) => {
      const result = await probeUrl(m.url);
      return { id: m.id, url: m.url, ...result };
    })
  );
}

module.exports = { probeUrl, probeAll };
