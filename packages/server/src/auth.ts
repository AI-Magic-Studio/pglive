import type { AuthConfig, AuthResult, Subscription } from './types.js';

export async function verifyConnection(
  token: string | undefined,
  config: AuthConfig
): Promise<AuthResult> {
  if (config.mode === 'none') return { allowed: true };
  // v2: JWT verification, webhook call
  return { allowed: true };
}

export async function verifySubscription(
  claims: Record<string, any> | undefined,
  subscription: Subscription,
  config: AuthConfig
): Promise<AuthResult> {
  if (config.mode === 'none') return { allowed: true };
  // v2: check claims against channel/table permissions
  return { allowed: true };
}
