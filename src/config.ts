// Env bindings — mirrors wrangler.toml. Keep in sync.
export interface Env {
  // Bindings
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;

  // Non-secret vars
  BOT_USERNAME: string;
  MINIAPP_SHORT_NAME: string;
  PUBLIC_ORIGIN: string;

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  CHANNEL_ID: string;             // parsed as number where used
  DISCUSSION_CHAT_ID: string;
  ADMIN_TELEGRAM_IDS: string;     // comma-separated
  JOIN_APPROVAL_PASSWORD?: string;

  // Optional. If unset, GitHub destination is skipped and bugs remain
  // Telegram-only. Set via `wrangler secret put GITHUB_TOKEN`.
  GITHUB_TOKEN?: string;
}

export function adminIds(env: Env): Set<number> {
  return new Set(
    env.ADMIN_TELEGRAM_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );
}

export function isAdmin(env: Env, tgUserId: number | undefined | null): boolean {
  if (!tgUserId) return false;
  return adminIds(env).has(tgUserId);
}

export function channelId(env: Env): number {
  return Number(env.CHANNEL_ID);
}

export function discussionChatId(env: Env): number {
  return Number(env.DISCUSSION_CHAT_ID);
}
