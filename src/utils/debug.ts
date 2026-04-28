/**
 * Debug mode configuration
 * When enabled, additional logging and warnings will be shown
 * Controlled via --debug startup flag
 */
let debugMode = false;

export function isDebugEnabled(): boolean {
  return debugMode;
}

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

/**
 * Log a debug message if debug mode is enabled
 */
export function debugLog(...args: unknown[]): void {
  if (debugMode) {
    console.warn(...args);
  }
}

/**
 * Log a warning if debug mode is enabled
 */
export function debugWarn(...args: unknown[]): void {
  if (debugMode) {
    console.warn(...args);
  }
}

/**
 * Log an error if debug mode is enabled
 */
export function debugError(...args: unknown[]): void {
  if (debugMode) {
    console.error(...args);
  }
}
