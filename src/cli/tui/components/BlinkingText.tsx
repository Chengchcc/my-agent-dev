import React from 'react';
import { Text } from 'ink';
import type { TextProps } from 'ink';
import { useBlink } from './BlinkContext';

interface BlinkingTextProps extends TextProps {
}

export function BlinkingText({
  children,
  ...props
}: BlinkingTextProps) {
  // Blinking is controlled by BlinkContext at the app level
  const visible = useBlink();

  if (visible) {
    return <Text {...props}>{children}</Text>;
  }

  return <Text {...props} dimColor>{children}</Text>;
}
