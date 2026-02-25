#!/usr/bin/env node
import { createPgLive } from './index.js';
import { parseConfig } from './config.js';

const config = parseConfig(process.argv.slice(2));
const server = createPgLive(config);

server.start().then(() => {
  const safeDb = (config.db || '').replace(/:[^:@]+@/, ':***@');
  console.log(`pgLive listening on ws://${server.config.host}:${server.config.port}`);
  console.log(`Connected to ${safeDb}`);
  console.log(`Publication: ${server.config.publication}, Slot: ${server.config.slot}`);
});
