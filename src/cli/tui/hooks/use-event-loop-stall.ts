import { useEffect, useRef } from 'react';
import { debugLog } from '../../../utils/debug';

const STALL_THRESHOLD_MS = 100;
const TICK_INTERVAL_MS = 50;

export function useEventLoopStall(enabled = true) {
  const lastTickRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTickRef.current;

      if (drift > STALL_THRESHOLD_MS) {
        debugLog(`[PERF] Event loop stalled: ${drift}ms (threshold: ${STALL_THRESHOLD_MS})`);
      }

      lastTickRef.current = now;
    }, TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [enabled]);
}
