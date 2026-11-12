import { describe, it, expect } from "vitest";
import { resolveSettings } from "../../src/config/resolve.js";
import type { AppConfig } from "../../src/config/env.js";

const envCfg = {
  databaseUrl: "x", chatwootBaseUrl: "x", credentialsKey: Buffer.alloc(32),
  port: 4000, publicBaseUrl: "x",
  chatwootApiAccessToken: "ENVTOK", chatwootAccountId: 9,
  webhookSecret: null, mediaArchiveRoot: "/a", mediaTokenTtlDays: 0, maxAttachmentBytes: 1, inboundConcurrency: 1, jobRetentionDays: 0,
  oa: undefined,
} as unknown as AppConfig;

const src = (m: Record<string, string>) => ({ getAll: async () => m });

describe("resolveSettings", () => {
  it("lets DB override env", async () => {
    const cfg = await resolveSettings(src({ chatwoot_account_id: "1", chatwoot_api_access_token: "DBTOK" }), envCfg);
    expect(cfg.chatwootAccountId).toBe(1);
    expect(cfg.chatwootApiAccessToken).toBe("DBTOK");
  });

  it("lets DB override chatwoot base url and trims a trailing slash", async () => {
    const cfg = await resolveSettings(src({ chatwoot_base_url: "http://chatwoot-db:3000/" }), envCfg);
    expect(cfg.chatwootBaseUrl).toBe("http://chatwoot-db:3000");
  });

  it("falls back to env when DB is empty", async () => {
    const cfg = await resolveSettings(src({}), envCfg);
    expect(cfg.chatwootApiAccessToken).toBe("ENVTOK");
    expect(cfg.chatwootAccountId).toBe(9);
  });

  it("falls back to env chatwoot base url when DB base url is empty", async () => {
    const cfg = await resolveSettings(src({}), envCfg);
    expect(cfg.chatwootBaseUrl).toBe("x");
  });

  it("builds oa from DB values", async () => {
    const cfg = await resolveSettings(src({ zalo_oa_app_id: "a", zalo_oa_app_secret: "b", zalo_oa_oauth_redirect: "c" }), envCfg);
    expect(cfg.oa).toEqual({ appId: "a", appSecret: "b", redirectUri: "c" });
  });

  it("leaves oa undefined when only partially configured", async () => {
    const cfg = await resolveSettings(src({ zalo_oa_app_id: "a" }), envCfg);
    expect(cfg.oa).toBeUndefined();
  });

  it("falls back to env on a DB read error", async () => {
    const cfg = await resolveSettings({ getAll: async () => { throw new Error("db"); } }, envCfg);
    expect(cfg.chatwootApiAccessToken).toBe("ENVTOK");
  });
});
