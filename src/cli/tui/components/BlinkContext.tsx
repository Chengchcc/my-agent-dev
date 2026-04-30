import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const DEFAULT_BLINK_INTERVAL_MS = 800;

const BlinkContext = createContext(true);

export function BlinkProvider({
  children,
  interval = DEFAULT_BLINK_INTERVAL_MS,
}: {
  children: ReactNode;
  interval?: number;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(v => !v);
    }, interval);
    return () => clearInterval(id);
  }, [interval]);

  return (
    <BlinkContext.Provider value={visible}>
      {children}
    </BlinkContext.Provider>
  );
}

export function useBlink() {
  return useContext(BlinkContext);
}
