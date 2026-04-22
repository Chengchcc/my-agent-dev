import React from 'react';
import { Text } from 'ink';
import type { TextProps } from 'ink';
import { useBlink } from './BlinkContext';

export interface BlinkingTextProps extends TextProps {
  /** Blink interval in milliseconds (default: 800 for slow/subtle blinking) */
  interval?: number;
}

export function BlinkingText({
  children,
  interval = 800,
  ...props
}: BlinkingTextProps) {
  // interval is not used in the component - only for backwards compatibility
  // actual interval is controlled by BlinkProvider
  const visible = useBlink();

  if (visible) {
    return <Text {...props}>{children}</Text>;
  }

  return <Text {...props} dimColor>{children}</Text>;
}
