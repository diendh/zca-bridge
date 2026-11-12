export interface OaConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  secretKey?: string; // OA Secret Key for webhook mac verification (distinct from appSecret)
}

export interface AppConfig {
  databaseUrl: string;
  chatwootBaseUrl: string;
  credentialsKey: Buffer; // 32 bytes
  port: number;
  publicBaseUrl: string; // bridge's own externally reachable URL (for webhook + iframe)
  // Optional: Application API access for posting failure notices to agents.
  // When absent, failed outbound sends are dead-lettered + logged but no in-conversation note is posted.
  chatwootApiAccessToken: string | null;
  chatwootAccountId: number | null;
  webhookSecret: string | null; // if set, embedded in the webhook URL path
  chatwootWebhookBase: string;  // internal base Chatwoot uses to reach the bridge (docker network)
  mediaArchiveRoot: string;   // local directory for the durable media archive
  mediaTokenTtlDays: number;  // 0 = links never expire
  maxAttachmentBytes: number; // Chatwoot upload cap; larger media → archive + link
  inboundConcurrency: number; // parallel inbound workers (outbound always has its own dedicated worker)
  jobRetentionDays: number;   // finished jobs older than this are purged; 0 = keep forever
  oa?: OaConfig;              // Optional OA (Official Account) integration config
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const keyHex = required(env, "CREDENTIALS_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("CREDENTIALS_KEY must be 64 hex chars (32 bytes)");
  }
  const oaAppId = env.ZALO_OA_APP_ID;
  const oaAppSecret = env.ZALO_OA_APP_SECRET;
  const oaRedirect = env.ZALO_OA_OAUTH_REDIRECT;
  const oa: OaConfig | undefined =
    oaAppId && oaAppSecret && oaRedirect
      ? { appId: oaAppId, appSecret: oaAppSecret, redirectUri: oaRedirect, secretKey: env.ZALO_OA_SECRET_KEY }
      : undefined;

  return {
    databaseUrl: required(env, "DATABASE_URL"),
    chatwootBaseUrl: required(env, "CHATWOOT_BASE_URL").replace(/\/$/, ""),
    credentialsKey: Buffer.from(keyHex, "hex"),
    port: Number(env.PORT ?? "4000"),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? "4000"}`).replace(/\/$/, ""),
    // Token & account id are operator-managed via Admin → Cấu hình and stored in the
    // settings DB (merged in resolveSettings). They are intentionally NOT read from env,
    // so the operator manages them in one place.
    chatwootApiAccessToken: null,
    chatwootAccountId: null,
    webhookSecret: env.WEBHOOK_SECRET ?? null,
    chatwootWebhookBase: (env.CHATWOOT_WEBHOOK_BASE ?? "http://zca-bridge:4000").replace(/\/$/, ""),
    mediaArchiveRoot: env.MEDIA_ARCHIVE_ROOT ?? "/archive",
    mediaTokenTtlDays: Number(env.MEDIA_TOKEN_TTL_DAYS ?? "0"),
    maxAttachmentBytes: Number(env.CHATWOOT_MAX_ATTACHMENT_MB ?? "40") * 1024 * 1024,
    inboundConcurrency: Math.max(1, Number(env.INBOUND_CONCURRENCY ?? "4") || 1),
    jobRetentionDays: Math.max(0, Number(env.JOB_RETENTION_DAYS ?? "30") || 0),
    oa,
  };
}
