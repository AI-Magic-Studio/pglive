import { describe, it, expect } from 'vitest';
import { mergeWithDefaults } from '../config.js';

describe('mergeWithDefaults', () => {
  it('fills in all defaults when given empty config', () => {
    const config = mergeWithDefaults({});

    expect(config.port).toBe(4400);
    expect(config.host).toBe('0.0.0.0');
    expect(config.publication).toBe('pglive');
    expect(config.slot).toBe('pglive_slot');
    expect(config.tables).toBeNull();
    expect(config.heartbeat).toBe(30);
    expect(config.maxClients).toBe(1000);
    expect(config.maxWalLagMb).toBe(100);
    expect(config.cors).toBe('*');
    expect(config.logLevel).toBe('info');
    expect(config.auth).toEqual({ mode: 'none' });
    expect(config.hooks).toEqual({});
  });

  it('custom values override defaults', () => {
    const config = mergeWithDefaults({
      port: 5500,
      host: '127.0.0.1',
      publication: 'my_pub',
      slot: 'my_slot',
      tables: ['users', 'orders'],
      heartbeat: 10,
      maxClients: 500,
      maxWalLagMb: 50,
      cors: 'https://example.com',
      logLevel: 'debug',
      auth: { mode: 'jwt', secret: 's3cret' },
      hooks: {},
    });

    expect(config.port).toBe(5500);
    expect(config.host).toBe('127.0.0.1');
    expect(config.publication).toBe('my_pub');
    expect(config.slot).toBe('my_slot');
    expect(config.tables).toEqual(['users', 'orders']);
    expect(config.heartbeat).toBe(10);
    expect(config.maxClients).toBe(500);
    expect(config.maxWalLagMb).toBe(50);
    expect(config.cors).toBe('https://example.com');
    expect(config.logLevel).toBe('debug');
    expect(config.auth).toEqual({ mode: 'jwt', secret: 's3cret' });
  });

  it('preserves db from partial config', () => {
    const config = mergeWithDefaults({ db: 'postgres://localhost/mydb' });
    expect(config.db).toBe('postgres://localhost/mydb');
  });

  it('handles zero values correctly (not treated as falsy)', () => {
    const config = mergeWithDefaults({
      port: 0,
      heartbeat: 0,
      maxClients: 0,
      maxWalLagMb: 0,
    });

    expect(config.port).toBe(0);
    expect(config.heartbeat).toBe(0);
    expect(config.maxClients).toBe(0);
    expect(config.maxWalLagMb).toBe(0);
  });
});
