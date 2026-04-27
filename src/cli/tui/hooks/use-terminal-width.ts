import { useState, useEffect } from 'react';

export function useTerminalWidth(): number {
  const [width, setWidth] = useState(() => process.stdout.columns || 80);

  useEffect(() => {
    const onResize = () => setWidth(process.stdout.columns || 80);
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  return width;
}
