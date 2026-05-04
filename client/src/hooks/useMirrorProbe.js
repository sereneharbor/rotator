import { useState, useCallback } from 'react';

const DEFAULT_TIMEOUT_MS = 3000;

async function probeMirror(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal, mode: 'no-cors' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sendLog(payload) {
  // keepalive: true ensures the request completes even after window.location.replace()
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // fire-and-forget — never block the redirect
  }
}

export function useMirrorProbe() {
  const [status, setStatus] = useState('idle'); // idle | probing | success | failed
  const [error, setError] = useState(null);

  const probe = useCallback(async (mirrors, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    setStatus('probing');
    setError(null);

    // Build current page's query params to forward
    const entryParams = new URLSearchParams(window.location.search);

    // No mirrors configured — keep spinner; nothing to probe yet
    if (mirrors.length === 0) {
      setStatus('probing');
      return;
    }

    // Probe all mirrors concurrently
    const results = await Promise.all(
      mirrors.map(async (mirror, index) => {
        const healthy = await probeMirror(mirror.url, timeoutMs);
        return { mirror, index, healthy };
      })
    );

    // Find first healthy mirror by original priority order (lowest index)
    const winner = results
      .filter((r) => r.healthy)
      .sort((a, b) => a.index - b.index)[0];

    if (!winner) {
      sendLog({ result: 'all_failed', entryParams: entryParams.toString() });
      setStatus('failed');
      setError('all_failed');
      return;
    }

    // Merge entry params into mirror URL without overwriting existing mirror params
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
    });

    setStatus('success');
    window.location.replace(targetUrl.toString());
  }, []);

  return { status, error, probe };
}
