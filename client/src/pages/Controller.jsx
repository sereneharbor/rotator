import { useEffect, useCallback } from 'react';
import { getMirrorsWithConfig } from '../api.js';
import { useMirrorProbe } from '../hooks/useMirrorProbe.js';

function Spinner() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
      <p className="text-white/70 text-sm tracking-widest uppercase">Connecting&hellip;</p>
    </div>
  );
}

export default function Controller() {
  const { status, error, probe } = useMirrorProbe();

  const runProbe = useCallback(async () => {
    try {
      const { mirrors, probeTimeoutMs } = await getMirrorsWithConfig();
      console.log(`[controller] ${mirrors.length} mirrors, timeout ${probeTimeoutMs}ms`);
      await probe(mirrors || [], probeTimeoutMs);
    } catch {
      await probe([], 7000);
    }
  }, [probe]);

  useEffect(() => {
    runProbe();
  }, [runProbe]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      {(status === 'idle' || status === 'probing' || status === 'success') && <Spinner />}

      {status === 'failed' && error === 'all_failed' && (
        <div className="flex flex-col items-center gap-6 text-center px-6">
          <p className="text-white/80 text-base max-w-sm">
            We&apos;re having trouble reaching our servers. Please try again in a moment.
          </p>
          <button
            onClick={runProbe}
            className="px-6 py-2.5 bg-white text-gray-900 font-semibold rounded-lg hover:bg-gray-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
