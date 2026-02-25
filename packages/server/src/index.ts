import { mergeWithDefaults } from './config.js';
import { SlotManager } from './slot-manager.js';
import { WalReader } from './wal-reader.js';
import { ChannelRouter } from './channel-router.js';
import { HookRunner } from './hooks.js';
import { WsManager } from './ws-manager.js';
import { metrics } from './metrics.js';
import { setLogLevel } from './logger.js';
import type { PgLiveConfig, Plugin, Change } from './types.js';

export function createPgLive(config: Partial<PgLiveConfig>) {
  const fullConfig = mergeWithDefaults(config);
  setLogLevel(fullConfig.logLevel);

  const slotManager = new SlotManager(fullConfig.db, fullConfig.slot, fullConfig.publication);
  const walReader = new WalReader({ db: fullConfig.db, slot: fullConfig.slot, publication: fullConfig.publication });
  const channelRouter = new ChannelRouter();
  const hookRunner = new HookRunner();
  const wsManager = new WsManager(fullConfig, channelRouter, hookRunner);

  if (fullConfig.hooks) {
    hookRunner.setConfigHooks(fullConfig.hooks);
  }

  let stopping = false;

  return {
    async start() {
      await slotManager.ensureSlot();

      walReader.on('change', async (change: Change) => {
        // Check table whitelist
        if (fullConfig.tables && !fullConfig.tables.includes(change.table)) return;

        metrics.changesReceived++;

        // Route to subscribers
        const subscribers = channelRouter.routeChange(change);
        if (subscribers.length === 0) return;

        // Run onChange hooks (can transform or drop)
        const finalChange = await hookRunner.runOnChange(change, subscribers);
        if (!finalChange) return;

        // Broadcast
        wsManager.broadcast(finalChange, subscribers);
        metrics.changesBroadcast += subscribers.length;
      });

      await walReader.start();
      await wsManager.start();

      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await this.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },

    async stop() {
      await wsManager.stop();
      await walReader.stop();
      await slotManager.dropSlot();
    },

    use(plugin: Plugin) {
      hookRunner.use(plugin);
    },

    config: fullConfig,
    metrics,
  };
}

// Re-export types
export type {
  PgLiveConfig,
  Plugin,
  Change,
  ChangeType,
  Subscription,
  Hooks,
  AuthConfig,
  AuthResult,
  WireMessage,
  FilterMap,
  MetricsSnapshot,
} from './types.js';
