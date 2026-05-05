import { useState, useCallback } from 'react';

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Probe a single mirror URL from the browser.
 * Returns { healthy, reason } — reason is set when unhealthy.
 *
 * Note: browser fetch with mode:'no-cors' returns opaque responses so we
 * cannot read HTTP status or body. Detection is timeout-based only.
 * Server-side probing (POST /api/probe) handles content analysis.
 */
async function probeMirror(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal, mode: 'no-cors' });
    return { healthy: true, reason: null };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { healthy: false, reason: `connection timed out after ${timeoutMs}ms` };
    }
    return { healthy: false, reason: err.message || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

function sendLog(payload) {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // fire-and-forget
  }
}

export function useMirrorProbe() {
  const [status, setStatus] = useState('idle'); // idle | probing | success | failed
  const [error, setError] = useState(null);

  const probe = useCallback(async (mirrors, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    setStatus('probing');
    setError(null);

    const entryParams = new URLSearchParams(window.location.search);

    if (mirrors.length === 0) {
      setStatus('probing');
      return;
    }

    // Probe all mirrors concurrently, capturing per-mirror detail
    const results = await Promise.all(
      mirrors.map(async (mirror, index) => {
        const { healthy, reason } = await probeMirror(mirror.url, timeoutMs);
        return { mirror, index, healthy, reason };
      })
    );

    // Build the per-mirror log payload (url hostname only — don't log full URLs to server)
    const mirrorResults = results.map((r) => ({
      id: r.mirror.id,
      url: r.mirror.url,
      healthy: r.healthy,
      reason: r.reason,
    }));

    // Select first healthy mirror by priority order
    const winner = results
      .filter((r) => r.healthy)
      .sort((a, b) => a.index - b.index)[0];

    if (!winner) {
      sendLog({ result: 'all_failed', entryParams: entryParams.toString(), mirrorResults });
      setStatus('failed');
      setError('all_failed');
      return;
    }

    // Merge entry params into mirror URL
    const targetUrl = new URL(winner.mirror.url);
    for (const [key, value] of entryParams.entries()) {
      if (!targetUrl.searchParams.has(key)) {
        targetUrl.searchParams.set(key, value);
      }
    }

    sendLog({
      result: 'redirected',
      redirectedTo: targetUrl.toString(),
      mirrorId: winner.mirror.id,
      entryParams: entryParams.toString(),
      mirrorResults,
    });

    setStatus('success');
    window.location.replace(targetUrl.toString());
  }, []);

  return { status, error, probe };
}
