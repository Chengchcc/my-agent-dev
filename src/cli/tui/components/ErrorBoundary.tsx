import { Box, Text } from 'ink';
import type { ErrorInfo, ReactNode } from 'react';
import React, { Component } from 'react';
import { debugError } from '../../../utils/debug';

interface Props {
  children: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const name = this.props.name || 'Component';
    debugError(`[${name}] Render error:`, error.message);
    debugError(`[${name}] Component stack:`, errorInfo.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>⚠️ Render Error</Text>
          <Text color="gray">{this.state.error?.message}</Text>
          <Text dimColor>
            {this.props.name || 'A component'} failed to render. The rest of the app should still work.
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}
