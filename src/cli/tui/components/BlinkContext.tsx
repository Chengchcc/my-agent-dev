import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const BlinkContext = createContext(true);

export function BlinkProvider({
  children,
  interval = 800,
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
