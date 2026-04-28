import { useState, useEffect } from 'react';

export function useTerminalWidth(debounceMs = 50): number {
  const [width, setWidth] = useState(() => process.stdout.columns || 80);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = process.stdout.columns || 80;
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
