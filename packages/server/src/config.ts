import type { PgLiveConfig } from './types.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function parseConfig(argv: string[] = []): Partial<PgLiveConfig> {
  const args = parseArgv(argv);

  const db = args.db || process.env.DATABASE_URL;
  if (!db) {
    console.error('Error: DATABASE_URL is required. Set it via environment variable or --db flag.');
    process.exit(1);
  }

  const logLevel = args['log-level'] || process.env.PGLIVE_LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel as any)) {
    console.error(`Error: Invalid log level "${logLevel}". Must be one of: ${LOG_LEVELS.join(', ')}`);
    process.exit(1);
  }

  const tablesEnv = args.tables || process.env.PGLIVE_TABLES;
  const tables = tablesEnv ? tablesEnv.split(',').map((t: string) => t.trim()) : null;

  return {
    db,
    port: parseInt(args.port || process.env.PGLIVE_PORT || '4400', 10),
    host: args.host || process.env.PGLIVE_HOST || '0.0.0.0',
    publication: args.publication || process.env.PGLIVE_PUBLICATION || 'pglive',
    slot: args.slot || process.env.PGLIVE_SLOT || 'pglive_slot',
    tables,
    heartbeat: parseInt(args.heartbeat || process.env.PGLIVE_HEARTBEAT || '30', 10),
    maxClients: parseInt(args['max-clients'] || process.env.PGLIVE_MAX_CLIENTS || '1000', 10),
    maxWalLagMb: parseInt(args['max-wal-lag-mb'] || process.env.PGLIVE_MAX_WAL_LAG_MB || '100', 10),
    cors: args.cors || process.env.PGLIVE_CORS || '*',
    logLevel: logLevel as PgLiveConfig['logLevel'],
    auth: {
      mode: (process.env.PGLIVE_AUTH_MODE as any) || 'none',
      secret: process.env.PGLIVE_JWT_SECRET,
    },
    hooks: {},
  };
}

export function mergeWithDefaults(partial: Partial<PgLiveConfig>): PgLiveConfig {
  return {
    db: partial.db || process.env.DATABASE_URL || '',
    port: partial.port ?? 4400,
    host: partial.host ?? '0.0.0.0',
    publication: partial.publication ?? 'pglive',
    slot: partial.slot ?? 'pglive_slot',
    tables: partial.tables ?? null,
    heartbeat: partial.heartbeat ?? 30,
    maxClients: partial.maxClients ?? 1000,
    maxWalLagMb: partial.maxWalLagMb ?? 100,
    cors: partial.cors ?? '*',
    logLevel: partial.logLevel ?? 'info',
    auth: partial.auth ?? { mode: 'none' },
    hooks: partial.hooks ?? {},
  };
}

function parseArgv(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}
