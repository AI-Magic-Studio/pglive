import { EventEmitter } from 'events';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import type { Pgoutput } from 'pg-logical-replication';
import { createLogger } from './logger.js';
import type { Change, ChangeType } from './types.js';

const log = createLogger('wal-reader');

interface RelationInfo {
  schema: string;
  name: string;
  columns: { name: string; typeOid: number; flags: number }[];
}

export class WalReader extends EventEmitter {
  private service: LogicalReplicationService | null = null;
  private relations: Map<number, RelationInfo> = new Map();
  private stopped: boolean = false;

  constructor(private config: { db: string; slot: string; publication: string }) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;

    this.service = new LogicalReplicationService(
      { connectionString: this.config.db },
      { acknowledge: { auto: true, timeoutSeconds: 10 } }
    );

    const plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: [this.config.publication],
    });

    this.service.on('data', (lsn: string, msg: Pgoutput.Message) => {
      this.handleMessage(lsn, msg);
    });

    this.service.on('error', (err: Error) => {
      log.error('Replication error:', err.message);
      this.emit('error', err);
    });

    const subscribe = () => {
      if (this.stopped || !this.service) return;

      this.service.subscribe(plugin, this.config.slot)
        .catch((err: Error) => {
          if (this.stopped) return;
          log.error('Subscription error, reconnecting in 1s:', err.message);
          this.emit('error', err);
          setTimeout(subscribe, 1000);
        });
    };

    log.info('Starting WAL reader...');
    subscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.service) {
      this.service.stop();
      this.service = null;
    }
  }

  private handleMessage(lsn: string, msg: Pgoutput.Message): void {
    switch (msg.tag) {
      case 'relation':
        this.handleRelation(msg as Pgoutput.MessageRelation);
        break;
      case 'insert':
        this.handleInsert(lsn, msg as Pgoutput.MessageInsert);
        break;
      case 'update':
        this.handleUpdate(lsn, msg as Pgoutput.MessageUpdate);
        break;
      case 'delete':
        this.handleDelete(lsn, msg as Pgoutput.MessageDelete);
        break;
      // Begin/Commit/Type — ignored in v1
    }
  }

  private handleRelation(msg: Pgoutput.MessageRelation): void {
    this.relations.set(msg.relationOid, {
      schema: msg.schema,
      name: msg.name,
      columns: msg.columns.map((col) => ({
        name: col.name,
        typeOid: col.typeOid,
        flags: col.flags,
      })),
    });
    log.debug(`Cached relation: ${msg.schema}.${msg.name} (oid=${msg.relationOid})`);
  }

  private handleInsert(lsn: string, msg: Pgoutput.MessageInsert): void {
    const relation = this.relations.get(msg.relation.relationOid);
    if (!relation) {
      log.warn(`Insert for unknown relation oid=${msg.relation.relationOid}`);
      return;
    }

    const change: Change = {
      type: 'INSERT',
      schema: relation.schema,
      table: relation.name,
      new: this.decodeRow(msg.new, relation),
      old: null,
      ts: new Date().toISOString(),
      id: lsn,
    };
    this.emit('change', change);
  }

  private handleUpdate(lsn: string, msg: Pgoutput.MessageUpdate): void {
    const relation = this.relations.get(msg.relation.relationOid);
    if (!relation) {
      log.warn(`Update for unknown relation oid=${msg.relation.relationOid}`);
      return;
    }

    const change: Change = {
      type: 'UPDATE',
      schema: relation.schema,
      table: relation.name,
      new: this.decodeRow(msg.new, relation),
      old: msg.old ? this.decodeRow(msg.old, relation) : null,
      ts: new Date().toISOString(),
      id: lsn,
    };
    this.emit('change', change);
  }

  private handleDelete(lsn: string, msg: Pgoutput.MessageDelete): void {
    const relation = this.relations.get(msg.relation.relationOid);
    if (!relation) {
      log.warn(`Delete for unknown relation oid=${msg.relation.relationOid}`);
      return;
    }

    const oldData = msg.old || msg.key;
    const change: Change = {
      type: 'DELETE',
      schema: relation.schema,
      table: relation.name,
      new: null,
      old: oldData ? this.decodeRow(oldData, relation) : null,
      ts: new Date().toISOString(),
      id: lsn,
    };
    this.emit('change', change);
  }

  private decodeRow(
    row: Record<string, any>,
    relation: RelationInfo
  ): Record<string, any> {
    // The pgoutput plugin already decodes column names/values for us
    // Just pass through the row data
    return { ...row };
  }
}
