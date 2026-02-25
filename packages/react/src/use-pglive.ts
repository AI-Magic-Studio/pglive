import { useState, useEffect, useRef } from 'react';
import type { Change, ChangeType } from '@pglive/client';
import { usePgLiveClient } from './provider.js';

export function usePgLive<T extends Record<string, any>>(
  table: string,
  options: {
    event?: ChangeType[];
    filter?: Record<string, any>;
    initialData?: T[];
    keyField?: string;
  } = {}
): {
  data: T[];
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error: Error | null;
} {
  const { event, filter, initialData = [], keyField = 'id' } = options;
  const pg = usePgLiveClient();
  const [data, setData] = useState<T[]>(initialData);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const channelRef = useRef<ReturnType<typeof pg.channel> | null>(null);

  useEffect(() => {
    const channel = pg.channel(`changes:${table}`);
    channelRef.current = channel;

    const handleChange = (change: Change) => {
      setData(prev => {
        switch (change.type) {
          case 'INSERT':
            return [...prev, change.new as T];
          case 'UPDATE': {
            const key = change.new?.[keyField];
            return prev.map(row =>
              row[keyField] === key ? { ...row, ...change.new } as T : row
            );
          }
          case 'DELETE': {
            const key = change.old?.[keyField];
            return prev.filter(row => row[keyField] !== key);
          }
          default:
            return prev;
        }
      });
    };

    // If specific events, register for each; otherwise register for all
    if (event && event.length > 0) {
      for (const e of event) {
        if (filter) {
          channel.on(e, { filter }, handleChange);
        } else {
          channel.on(e, handleChange);
        }
      }
    } else {
      if (filter) {
        channel.on('*', { filter }, handleChange);
      } else {
        channel.on('*', handleChange);
      }
    }

    channel.subscribe();

    // Connection status
    pg.on('connected', () => setStatus('connected'));
    pg.on('disconnected', () => setStatus('disconnected'));
    pg.on('error', (err: Error) => {
      setStatus('error');
      setError(err);
    });

    return () => {
      channel.unsubscribe();
    };
  }, [table, keyField]);
  // Note: intentionally not including filter/event in deps to avoid re-subscribing on every render

  return { data, status, error };
}
