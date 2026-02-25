import type { AuthResult, Change, Hooks, Plugin, Subscription } from './types.js';

export class HookRunner {
  private plugins: Plugin[] = [];
  private configHooks: Partial<Hooks> = {};

  setConfigHooks(hooks: Partial<Hooks>): void {
    this.configHooks = hooks;
  }

  use(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async runOnConnect(socket: any, token: string | undefined): Promise<AuthResult> {
    // Config hook first
    if (this.configHooks.onConnect) {
      const result = await this.configHooks.onConnect(socket, token);
      if (!result.allowed) return result;
    }

    // Then plugins in order
    for (const plugin of this.plugins) {
      if (plugin.hooks.onConnect) {
        const result = await plugin.hooks.onConnect(socket, token);
        if (!result.allowed) return result;
      }
    }

    return { allowed: true };
  }

  async runOnSubscribe(socket: any, subscription: Subscription): Promise<AuthResult> {
    if (this.configHooks.onSubscribe) {
      const result = await this.configHooks.onSubscribe(socket, subscription);
      if (!result.allowed) return result;
    }

    for (const plugin of this.plugins) {
      if (plugin.hooks.onSubscribe) {
        const result = await plugin.hooks.onSubscribe(socket, subscription);
        if (!result.allowed) return result;
      }
    }

    return { allowed: true };
  }

  async runOnChange(change: Change, subscribers: Subscription[]): Promise<Change | null> {
    let current: Change | null = change;

    if (this.configHooks.onChange) {
      current = await this.configHooks.onChange(current, subscribers);
      if (!current) return null;
    }

    for (const plugin of this.plugins) {
      if (plugin.hooks.onChange && current) {
        current = await plugin.hooks.onChange(current, subscribers);
        if (!current) return null;
      }
    }

    return current;
  }

  async runOnDisconnect(socket: any, reason: string): Promise<void> {
    if (this.configHooks.onDisconnect) {
      await this.configHooks.onDisconnect(socket, reason);
    }

    for (const plugin of this.plugins) {
      if (plugin.hooks.onDisconnect) {
        await plugin.hooks.onDisconnect(socket, reason);
      }
    }
  }
}
