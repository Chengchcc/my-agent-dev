export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export function consoleLogger(options?: { level?: LogLevel }): Logger {
  const level = options?.level ?? "info";

  return {
    level,
    debug(message, ...args) {
      if (LEVEL_ORDER[level] <= LEVEL_ORDER.debug) console.debug(message, ...args);
    },
    info(message, ...args) {
      if (LEVEL_ORDER[level] <= LEVEL_ORDER.info) console.log(message, ...args);
    },
    warn(message, ...args) {
      if (LEVEL_ORDER[level] <= LEVEL_ORDER.warn) console.warn(message, ...args);
    },
    error(message, ...args) {
      if (LEVEL_ORDER[level] <= LEVEL_ORDER.error) console.error(message, ...args);
    },
  };
}

export function noopLogger(): Logger {
  return {
    level: "silent",
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
