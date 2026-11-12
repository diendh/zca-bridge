import Fastify, { type FastifyBaseLogger } from "fastify";
import fastifyStatic from "@fastify/static";
import pino from "pino";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config/env.js";
import { resolveSettings } from "./config/resolve.js";
import { createPool } from "./store/db.js";
import { runMigrations } from "./store/migrate.js";
import { AccountRepo } from "./store/accountRepo.js";
import { MappingRepo } from "./store/mappingRepo.js";
import { ConversationRepo } from "./store/conversationRepo.js";
import { JobQueueRepo, Job } from "./store/jobQueueRepo.js";
import { SettingsRepo } from "./store/settingsRepo.js";
import { AdminUserRepo } from "./store/adminUserRepo.js";
import { LogsRepo } from "./store/logsRepo.js";
import { DbLogStream } from "./logging/dbLogStream.js";
import { loadAlertConfig, buildNotifiers } from "./alerting/config.js";
import { AlertDispatcher } from "./alerting/dispatcher.js";
import { AlertStream } from "./alerting/alertStream.js";
import { ChatwootClient } from "./chatwoot/client.js";
import { makeAppClientFor } from "./chatwoot/appClientFactory.js";
import { ChatwootAdminClient } from "./chatwoot/adminClient.js";
import { registerWebhookRoute, OutgoingEvent } from "./chatwoot/webhookServer.js";
import { registerAdminRoutes, registerAccountDeleteRoute } from "./admin/routes.js";
import { registerAuthRoutes, makeRequireSession } from "./admin/authRoutes.js";
import { registerSettingsRoutes } from "./admin/settingsRoutes.js";
import { registerLogsRoutes } from "./admin/logsRoutes.js";
import { buildWebhookUrls, registerWebhookInfoRoutes } from "./admin/webhookInfoRoutes.js";
import { deriveSessionSecret } from "./admin/auth.js";
import { SessionManager } from "./zalo/sessionManager.js";
import { ReconnectSupervisor, isZaloAuthError } from "./zalo/reconnectSupervisor.js";
import { ZcaAdapter } from "./zalo/zcaAdapter.js";
import { ZcaQrLoginService } from "./zalo/qrLoginService.js";
import { ProxyRepo } from "./store/proxyRepo.js";
import { buildProxyOptions, type ProxyOptions } from "./zalo/proxyOptions.js";
import { registerProxyRoutes } from "./admin/proxyRoutes.js";
import { InboundHandler } from "./handlers/inbound.js";
import { OutboundHandler } from "./handlers/outbound.js";
import { makeOutboundNotifier } from "./handlers/outboundNotify.js";
import { deadLetterNote, windowNote } from "./handlers/outboundNotes.js";
import { ReactionHandler, UndoHandler } from "./handlers/events.js";
import { makeEnricher } from "./handlers/enrichment.js";
import { Worker } from "./worker/worker.js";
import { decryptCredentials, encryptCredentials } from "./crypto/credentials.js";
import { IncomingMessage, ReactionEvent, UndoEvent } from "./zalo/types.js";
import { LocalDiskArchive } from "./media/archive.js";
import { registerMediaRoute } from "./media/mediaRoute.js";
import { ExtensionRegistry, type ExtensionContext } from "./extension/registry.js";
import { loadPro } from "./extension/loadPro.js";
import { OaTokenRepo } from "./store/oaTokenRepo.js";
import { OaOAuthClient } from "./zalo-oa/oauthClient.js";
import { OaSender } from "./zalo-oa/sender.js";
import { registerOaWebhookRoute } from "./zalo-oa/webhookRoute.js";
import { registerOaOAuthRoutes } from "./zalo-oa/oauthRoute.js";
import { startOaTokenRefresher } from "./zalo-oa/tokenRefresher.js";
import { fetchOaId, accessTokenProvider, fetchUserProfile } from "./zalo-oa/oaRuntime.js";
import { ConsultationTracker } from "./zalo-oa/consultationTracker.js";
import { InfoCardRepo } from "./store/infoCardRepo.js";
import { InfoRequestTracker } from "./zalo-oa/infoRequestTracker.js";
import { sendRequestUserInfo } from "./zalo-oa/requestInfoSender.js";
import { parseSharedInfo } from "./zalo-oa/sharedInfo.js";
import { applyContactInfo } from "./handlers/contactInfoSink.js";
import { registerInfoCardRoutes } from "./admin/infoCardRoutes.js";
import { encodeSourceId, ThreadKind } from "./routing/sourceId.js";
import { listRecentChat, getConversationMessages } from "./zalo-oa/historyClient.js";
import { runBackfill, DEFAULT_CAPS, HistoryClient } from "./zalo-oa/oaBackfill.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const envCfg = loadConfig();
  await runMigrations(envCfg.databaseUrl);

  const pool = createPool(envCfg.databaseUrl);
  const logsRepo = new LogsRepo(pool);
  const settingsRepo = new SettingsRepo(pool, envCfg.credentialsKey);
  const alertConfig = await loadAlertConfig(settingsRepo);
  const alertDispatcher = new AlertDispatcher(buildNotifiers(alertConfig), {
    cooldownMs: alertConfig.cooldownMs,
    reconnectingThresholdMs: alertConfig.reconnectingThresholdMs,
  });
  const alertStream = new AlertStream(alertDispatcher);
  const dbLogStream = new DbLogStream({
    insert: (rows) => logsRepo.insertMany(rows),
    prune: (keep) => logsRepo.prune(keep),
  });
  const logger = pino(
    { level: "info" },
    pino.multistream([{ stream: process.stdout }, { stream: dbLogStream }, { stream: alertStream }]),
  );
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  const cfg = await resolveSettings(settingsRepo, envCfg, app.log);

  const extensions = new ExtensionRegistry();
  await loadPro(extensions, undefined, app.log);
  const extCtx: ExtensionContext = {
    mediaArchiveRoot: cfg.mediaArchiveRoot,
    publicBaseUrl: cfg.publicBaseUrl,
    credentialsKey: cfg.credentialsKey,
    mediaTokenTtlDays: cfg.mediaTokenTtlDays,
  };

  const sessionSecret = deriveSessionSecret(envCfg.credentialsKey);
  const adminUsers = new AdminUserRepo(pool);
  const guard = makeRequireSession(sessionSecret);

  const adminAuth = extensions.adminAuth?.({ pool, sessionSecret });
  if (adminAuth) await adminAuth.ensureSchema();
  // can(key): dưới Pro = requirePermission(key); dưới Free = guard (single-admin toàn quyền).
  const can = (key: string) => (adminAuth ? adminAuth.requirePermission(key) : guard);

  const accounts = new AccountRepo(pool);
  const mapping = new MappingRepo(pool);
  const proxyRepo = new ProxyRepo(pool, cfg.credentialsKey);
  const conversations = new ConversationRepo(pool);
  const jobs = new JobQueueRepo(pool);
  const chatwoot = new ChatwootClient(cfg.chatwootBaseUrl);
  const appClientFor = makeAppClientFor(cfg.chatwootBaseUrl, cfg.chatwootApiAccessToken, cfg.chatwootAccountId, accounts);
  const archive = extensions.mediaArchive
    ? extensions.mediaArchive(extCtx)
    : new LocalDiskArchive(cfg.mediaArchiveRoot, cfg.publicBaseUrl, cfg.credentialsKey, cfg.mediaTokenTtlDays);
  const webhookUrls = buildWebhookUrls({
    chatwootWebhookBase: cfg.chatwootWebhookBase,
    webhookSecret: cfg.webhookSecret,
    publicBaseUrl: cfg.publicBaseUrl,
  });
  const chatwootAdmin = new ChatwootAdminClient(cfg.chatwootBaseUrl, cfg.chatwootApiAccessToken);

  // inbox_id -> identifier index, refreshed from DB
  const inboxIndex = new Map<number, string>();
  async function refreshIndex(): Promise<void> {
    const nextIndex = new Map<number, string>();
    for (const a of await accounts.listAll()) {
      if (a.chatwootInboxId) nextIndex.set(a.chatwootInboxId, a.chatwootInboxIdentifier);
    }
    inboxIndex.clear();
    for (const [inboxId, identifier] of nextIndex) inboxIndex.set(inboxId, identifier);
  }

  const sessions = new SessionManager();

  const infoCard = new InfoCardRepo(pool);
  // OA infra (tokens/oauth) only exists inside the `if (cfg.oa)` block below, so the
  // tracker is bound late via this ref — same pattern as oaProfileRef.
  const infoRequestRef: { tracker: InfoRequestTracker | null } = { tracker: null };
  const infoRequestHook = { onInbound: (accountId: number, sourceId: string) => infoRequestRef.tracker ? infoRequestRef.tracker.onInbound(accountId, sourceId) : Promise.resolve() };

  // OA accounts have no zca session; their contact profiles come from the OA API instead.
  // The resolver is wired in the `if (cfg.oa)` block below once OA token infra exists.
  const oaProfileRef: { resolve: ((accountId: number, userId: string) => Promise<{ displayName: string; avatar?: string } | null>) | null } = { resolve: null };
  const enrich = makeEnricher(sessions, chatwoot, (a, u) => (oaProfileRef.resolve ? oaProfileRef.resolve(a, u) : Promise.resolve(null)), app.log);
  const consult = new ConsultationTracker(conversations, async (accountId, sourceId, text) => {
    const convId = await conversations.getChatwootId(accountId, sourceId);
    if (convId) await (await appClientFor(accountId)).postPrivateNote(convId, text);
  });
  const watermarkHook = {
    onRelayed: (accountId: number, timeMs: number) =>
      accounts.advanceWatermark(accountId, timeMs).catch((err) => app.log.warn({ event: "watermark_advance_failed", accountId, err }, "watermark advance failed")),
  };
  const inbound = new InboundHandler(
    chatwoot, mapping, conversations, enrich, appClientFor, archive, cfg.maxAttachmentBytes, app.log,
    consult, infoRequestHook, watermarkHook,
    (accountId, groupId) => sessions.getGroupInfo(accountId, groupId).catch(() => null),
  );
  const notifyOutbound = makeOutboundNotifier((id) => inboxIndex.get(id) ?? null, accounts, conversations, appClientFor, app.log);
  const outbound = new OutboundHandler(
    sessions, accounts, (id) => inboxIndex.get(id) ?? null, mapping, cfg.chatwootBaseUrl,
    (evt, error) => notifyOutbound(evt, windowNote(evt, error)),
    app.log,
    consult,
    notifyOutbound,
    archive,
  );
  const reactions = new ReactionHandler(conversations, mapping, appClientFor);
  const undos = new UndoHandler(conversations, mapping, appClientFor);

  // Wake the workers the instant a job is enqueued, so processing does not wait for the poll tick.
  let wakeWorker: () => void = () => {};
  // Zalo-side events of one conversation share a lane so parallel workers keep them in order.
  const laneOf = (accountId: number, threadId: string): string => `${accountId}:${threadId}`;
  let runStartupBackfill: () => void = () => {};

  // DURABLE PATH: a Zalo message is persisted to job_queue before any Chatwoot call.
  const onInbound = (accountId: number, msg: IncomingMessage): void => {
    jobs.enqueue("inbound", `${accountId}:${msg.msgId}`, { accountId, msg }, laneOf(accountId, msg.threadId))
      .then(() => wakeWorker())
      .catch((err) => app.log.error({ err }, "failed to enqueue inbound"));
  };

  const onReaction = (accountId: number, evt: ReactionEvent): void => {
    jobs.enqueue("reaction", `${accountId}:${evt.reactedMsgId}:${evt.icon}:${evt.isSelf}`, { accountId, evt }, laneOf(accountId, evt.threadId))
      .then(() => wakeWorker())
      .catch((err) => app.log.error({ err }, "failed to enqueue reaction"));
  };

  const onUndo = (accountId: number, evt: UndoEvent): void => {
    jobs.enqueue("undo", `${accountId}:${evt.recalledMsgId}`, { accountId, evt }, laneOf(accountId, evt.threadId))
      .then(() => wakeWorker())
      .catch((err) => app.log.error({ err }, "failed to enqueue undo"));
  };
  sessions.registerEventHandlers(onReaction, onUndo);

  // Worker dispatches queued jobs to the handlers.
  const dispatch = async (job: Job): Promise<void> => {
    if (job.kind === "inbound") {
      const { accountId, msg } = job.payload as { accountId: number; msg: IncomingMessage };
      const acc = await accounts.findById(accountId);
      if (acc) await inbound.handle(accountId, acc.chatwootInboxIdentifier, msg);
      return;
    }
    if (job.kind === "reaction") {
      const { accountId, evt } = job.payload as { accountId: number; evt: ReactionEvent };
      await reactions.handle(accountId, evt);
      return;
    }
    if (job.kind === "undo") {
      const { accountId, evt } = job.payload as { accountId: number; evt: UndoEvent };
      await undos.handle(accountId, evt);
      return;
    }
    await outbound.handle(job.payload as OutgoingEvent);
  };

  // On permanent failure of an outbound send, alert the agent in-conversation.
  const onPermanentFailure = async (job: Job, error: unknown): Promise<void> => {
    app.log.error({ event: "job_dead_lettered", kind: job.kind, dedupKey: job.dedupKey, err: error }, "job dead-lettered");
    if (job.kind !== "outbound") return;
    // The note identifies which message failed and carries the underlying error verbatim, so the
    // agent can tell what broke and how to fix it (not just "check the connection").
    await notifyOutbound(job.payload as OutgoingEvent, deadLetterNote(job.payload as OutgoingEvent, error));
  };

  // Two lanes. Agent replies (and recall/reaction events) get a dedicated worker, so they never queue
  // behind a slow inbound job (media download, Chatwoot upload). Inbound runs N-wide in parallel
  // across conversations; lane_key keeps each conversation strictly ordered.
  const workers = [
    new Worker(jobs, dispatch, onPermanentFailure, 250, app.log, ["outbound", "undo", "reaction"]),
    ...Array.from({ length: cfg.inboundConcurrency }, () =>
      new Worker(jobs, dispatch, onPermanentFailure, 250, app.log, ["inbound"])),
  ];
  wakeWorker = () => { for (const w of workers) w.wake(); };

  const resolveProxyOptions = async (accountId: number): Promise<ProxyOptions> => {
    const acc = await accounts.findById(accountId);
    if (!acc?.proxyId) return {};
    const proxy = await proxyRepo.get(acc.proxyId);
    return buildProxyOptions(proxy);
  };

  const supervisor = new ReconnectSupervisor({
    loadCredentials: async (id) => {
      const blob = await mapping.loadCredentials(id);
      return blob ? decryptCredentials<any>(blob, cfg.credentialsKey) : null;
    },
    saveCredentials: async (id, creds) => {
      await mapping.saveCredentials(id, encryptCredentials(creds, cfg.credentialsKey));
    },
    createAdapter: async (accountId, creds) => ZcaAdapter.fromCredentials(creds, await resolveProxyOptions(accountId)),
    isAuthError: isZaloAuthError,
    register: (id, adapter) => sessions.register(id, adapter as any),
    unregister: (id) => sessions.remove(id),
    bindInbound: (id) => sessions.bindInbound(id, onInbound),
    setStatus: async (id, status) => {
      await accounts.updateStatus(id, status);
      if (status === "connected") await accounts.clearProxyPending(id);
    },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
    log: app.log,
  });

  // Restore personal sessions (connected or mid-reconnect) under supervision.
  for (const acc of await accounts.listAll()) {
    if (acc.type === "oa") continue;
    if (acc.status !== "connected" && acc.status !== "reconnecting") continue;
    await supervisor.connect(acc.id).catch((err) => app.log.error({ event: "zalo_restore_failed", accountId: acc.id, err }, "failed to restore zalo session"));
  }

  const qr = new ZcaQrLoginService(supervisor, accounts, mapping, cfg.credentialsKey, resolveProxyOptions);

  await app.register(fastifyStatic, { root: join(here, "admin/public"), prefix: "/admin/" });
  // DURABLE PATH: webhook persists the event then returns 200 immediately.
  registerWebhookRoute(app, (evt) =>
    jobs.enqueue("outbound", String(evt.chatwootMessageId), evt).then(() => wakeWorker()), cfg.webhookSecret);
  registerMediaRoute(app, archive, cfg.credentialsKey);
  const requestRestart = (): void => {
    app.log.info("config changed via admin; restarting to apply");
    setTimeout(() => process.exit(0), 500);
  };
  app.get("/healthz", async () => ({ ok: true }));
  registerAuthRoutes(app, { users: adminUsers, sessionSecret });
  registerAdminRoutes(app, accounts, qr, guard, {
    refreshInboxIndex: refreshIndex,
    applyProxy: async (id) => { await supervisor.remove(id); await supervisor.connect(id); },
    listChatwootAccounts: () => chatwootAdmin.listAccounts(),
    requireWrite: can("accounts.write"),
    chatwootTokenConfigured: cfg.chatwootApiAccessToken != null,
  });
  registerAccountDeleteRoute(app, accounts, supervisor, refreshIndex, guard, can("accounts.write"));
  registerSettingsRoutes(app, settingsRepo, guard, requestRestart, can("settings.write"));
  registerLogsRoutes(app, logsRepo, guard);
  registerInfoCardRoutes(app, infoCard, guard, can("infocard.write"));
  registerProxyRoutes(app, proxyRepo, accounts, guard, can("proxy.write"));
  registerWebhookInfoRoutes(app, webhookUrls, guard);
  if (adminAuth) await adminAuth.registerRoutes(app);
  app.addHook("onReady", refreshIndex);

  if (cfg.oa) {
    const oaTokens = new OaTokenRepo(pool, cfg.credentialsKey);
    const oauth = new OaOAuthClient(cfg.oa.appId, cfg.oa.appSecret);

    // Enrich OA contacts (name + avatar) via the OA user-detail API.
    oaProfileRef.resolve = async (accountId, userId) => {
      try {
        const token = await accessTokenProvider(oaTokens, oauth, accountId)();
        return await fetchUserProfile(token, userId);
      } catch {
        return null;
      }
    };

    infoRequestRef.tracker = new InfoRequestTracker(
      conversations,
      infoCard,
      (accountId, userId, card) => sendRequestUserInfo(accessTokenProvider(oaTokens, oauth, accountId), userId, card),
      app.log,
    );

    const onSharedInfo = async (accountId: number, event: any): Promise<void> => {
      const info = parseSharedInfo(event);
      if (!info) { app.log.info({ event: "shared_info_empty", accountId }, "user_submit_info had no usable fields"); return; }
      const userId = String(event?.sender?.id ?? "");
      if (!userId) return;
      const acc = await accounts.findById(accountId);
      if (!acc) return;
      const sourceId = encodeSourceId(ThreadKind.OaUser, userId);
      await applyContactInfo(chatwoot, acc.chatwootInboxIdentifier, sourceId, info, app.log);
    };

    const registerOaSender = (accountId: number): void => {
      sessions.registerSender(accountId, new OaSender(accessTokenProvider(oaTokens, oauth, accountId)));
    };
    for (const acc of await accounts.listAll()) {
      if (acc.type === "oa" && acc.status === "connected") registerOaSender(acc.id);
    }

    runStartupBackfill = () => {
      void (async () => {
        for (const acc of await accounts.listAll()) {
          if (acc.type !== "oa" || acc.status !== "connected" || !acc.zaloOaId) continue;
          try {
            const getToken = accessTokenProvider(oaTokens, oauth, acc.id);
            const watermark = await accounts.getWatermark(acc.id);
            if (watermark == null) {
              await accounts.advanceWatermark(acc.id, Date.now());
              app.log.info({ event: "backfill_baseline", accountId: acc.id }, "backfill watermark initialised (no catch-up on first run)");
              continue;
            }
            const client: HistoryClient = {
              listRecentChat: (oaId, offset, count) => listRecentChat(getToken, oaId, offset, count),
              getConversationMessages: (userId, offset, count) => getConversationMessages(getToken, userId, offset, count),
            };
            const res = await runBackfill(client, acc.zaloOaId, watermark, (msg) => onInbound(acc.id, msg), DEFAULT_CAPS, app.log);
            if (res.maxTimeMs > watermark) await accounts.advanceWatermark(acc.id, res.maxTimeMs);
            if (res.capped) app.log.warn({ event: "backfill_capped", accountId: acc.id, enqueued: res.enqueued }, "OA backfill hit caps; some messages may not have been pulled");
          } catch (err) {
            app.log.warn({ event: "backfill_failed", accountId: acc.id, err }, "OA startup backfill failed");
          }
        }
      })().catch((err) => app.log.warn({ event: "backfill_failed", err }, "OA startup backfill loop failed"));
    };

    await app.register(async (oaApp) => {
      registerOaWebhookRoute(oaApp, { appId: cfg.oa!.appId, oaSecretKey: cfg.oa!.secretKey ?? "", accounts, onInbound, onSharedInfo });
    });
    registerOaOAuthRoutes(app, {
      oauth, tokens: oaTokens, accounts, redirectUri: cfg.oa.redirectUri, sessionSecret,
      fetchOaId: (at) => fetchOaId(at), onConnected: registerOaSender,
    });

    const stopRefresher = startOaTokenRefresher({ tokens: oaTokens, oauth, accounts, log: app.log });
    process.once("SIGTERM", stopRefresher);
    process.once("SIGINT", stopRefresher);
  }

  await app.listen({ host: "0.0.0.0", port: cfg.port });
  const requeued = await jobs.requeueInFlight();
  if (requeued > 0) app.log.info({ event: "jobs_requeued", count: requeued }, "requeued jobs left in-flight by the previous run");
  for (const w of workers) w.start();
  app.log.info({ event: "workers_started", inbound: cfg.inboundConcurrency, outbound: 1 }, "job workers started");
  runStartupBackfill();

  const purgeDone = (): void => {
    if (cfg.jobRetentionDays <= 0) return;
    jobs.purgeDone(cfg.jobRetentionDays)
      .then((n) => { if (n > 0) app.log.info({ event: "jobs_purged", count: n }, "purged finished jobs"); })
      .catch((err) => app.log.error({ err }, "job purge failed"));
  };
  purgeDone();
  const purgeTimer = setInterval(purgeDone, 60 * 60 * 1000);
  purgeTimer.unref();

  const indexRefresh = setInterval(() => { refreshIndex().catch((err) => app.log.error({ err }, "index refresh failed")); }, 30_000);
  indexRefresh.unref();

  // Re-persist live cookies every 30 min so a restart logs in with a fresh cookie, not the QR-time one.
  const cookieTimer = setInterval(() => { void supervisor.persistAllCookies(); }, 30 * 60 * 1000);
  cookieTimer.unref();

  async function shutdown(): Promise<void> {
    for (const w of workers) w.stop();
    clearInterval(purgeTimer);
    clearInterval(indexRefresh);
    clearInterval(cookieTimer);
    try { await supervisor.persistAllCookies(); } catch { /* ignore */ }
    try { await sessions.stopAll(); } catch { /* ignore */ }
    try { await app.close(); } catch { /* ignore */ }
    try { await pool.end(); } catch { /* ignore */ }
  }
  process.once("SIGTERM", () => { shutdown().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { shutdown().finally(() => process.exit(0)); });

  app.log.info(`zca-bridge listening on ${cfg.port}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
