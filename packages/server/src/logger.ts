const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let globalLevel: keyof typeof LOG_LEVELS = 'info';

export function setLogLevel(level: keyof typeof LOG_LEVELS): void {
  globalLevel = level;
}

export function createLogger(prefix: string) {
  const shouldLog = (level: keyof typeof LOG_LEVELS) =>
    LOG_LEVELS[level] >= LOG_LEVELS[globalLevel];

  return {
    debug: (...args: any[]) => shouldLog('debug') && console.debug(`[${prefix}]`, ...args),
    info: (...args: any[]) => shouldLog('info') && console.log(`[${prefix}]`, ...args),
    warn: (...args: any[]) => shouldLog('warn') && console.warn(`[${prefix}]`, ...args),
    error: (...args: any[]) => shouldLog('error') && console.error(`[${prefix}]`, ...args),
  };
}
