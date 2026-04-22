import React, { useState, useEffect, useRef } from 'react';
import { Text } from 'ink';
import type { TextProps } from 'ink';

export interface BlinkingTextProps extends TextProps {
  /** Blink interval in milliseconds (default: 800 for slow/subtle blinking) */
  interval?: number;
}

export function BlinkingText({
  children,
  interval = 800,
  ...props
}: BlinkingTextProps) {
  const [visible, setVisible] = useState(true);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setVisible(v => !v);
    }, interval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [interval]);

  if (visible) {
    return <Text {...props}>{children}</Text>;
  }

  return <Text {...props} dimColor>{children}</Text>;
}
