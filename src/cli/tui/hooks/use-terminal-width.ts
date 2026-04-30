import { useState, useEffect } from 'react';

const DEBOUNCE_DEFAULT_MS = 50;
const FALLBACK_TERMINAL_WIDTH = 80;

export function useTerminalWidth(debounceMs = DEBOUNCE_DEFAULT_MS): number {
  const [width, setWidth] = useState(() => process.stdout.columns || FALLBACK_TERMINAL_WIDTH);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = process.stdout.columns || FALLBACK_TERMINAL_WIDTH;
        setWidth(prev => (prev === next ? prev : next));
      }, debounceMs);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
      clearTimeout(timer);
    };
  }, [debounceMs]);

  return width;
}
