import { createContext, useContext, useEffect, useRef } from 'react';
import { PgLive } from '@pglive/client';

const PgLiveContext = createContext<PgLive | null>(null);

export function PgLiveProvider({ url, token, children }: {
  url: string;
  token?: string;
  children: React.ReactNode;
}) {
  const pgRef = useRef<PgLive | null>(null);

  if (!pgRef.current) {
    pgRef.current = new PgLive(url, { token });
  }

  useEffect(() => {
    return () => {
      pgRef.current?.close();
    };
  }, []);

  return (
    <PgLiveContext.Provider value={pgRef.current}>
      {children}
    </PgLiveContext.Provider>
  );
}

export function usePgLiveClient(): PgLive {
  const pg = useContext(PgLiveContext);
  if (!pg) throw new Error('usePgLiveClient must be used within PgLiveProvider');
  return pg;
}
