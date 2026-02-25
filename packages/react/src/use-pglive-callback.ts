import { useEffect, useRef } from 'react';
import type { Change, ChangeType } from '@pglive/client';
import { usePgLiveClient } from './provider.js';

export function usePgLiveCallback<T extends Record<string, any>>(
  table: string,
  options: {
    event?: ChangeType[];
    filter?: Record<string, any>;
    callback: (change: Change) => void;
  }
): void {
  const pg = usePgLiveClient();
  const callbackRef = useRef(options.callback);
  callbackRef.current = options.callback;

  useEffect(() => {
    const channel = pg.channel(`changes:${table}`);

    const handleChange = (change: Change) => {
      callbackRef.current(change);
    };

    if (options.event && options.event.length > 0) {
      for (const e of options.event) {
        if (options.filter) {
          channel.on(e, { filter: options.filter }, handleChange);
        } else {
          channel.on(e, handleChange);
        }
      }
    } else {
      if (options.filter) {
        channel.on('*', { filter: options.filter }, handleChange);
      } else {
        channel.on('*', handleChange);
      }
    }

    channel.subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [table]);
}
