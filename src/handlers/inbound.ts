import { request } from "undici";
import { ChatwootClient, Attachment } from "../chatwoot/client.js";
import type { AppClientFor } from "../chatwoot/appClientFactory.js";
import { MappingRepo } from "../store/mappingRepo.js";
import { ConversationRepo } from "../store/conversationRepo.js";
import { IncomingMessage, ZaloThreadKind, GroupProfile, toRoutingKindOf } from "../zalo/types.js";
import { MediaKind, MEDIA_LABEL } from "../zalo/classify.js";
import { MediaArchive } from "../media/archive.js";
import { encodeSourceId } from "../routing/sourceId.js";
import { EventLog, NOOP_LOG } from "../logging/eventLog.js";

type EnrichFn = (accountId: number, sourceId: string, identifier: string, senderUid: string) => Promise<void>;
type GroupProfileResolver = (accountId: number, groupId: string) => Promise<GroupProfile | null>;

interface ConsultHook { onInbound(accountId: number, sourceId: string): Promise<void>; }
interface InfoRequestHook { onInbound(accountId: number, sourceId: string): Promise<void>; }
interface WatermarkHook { onRelayed(accountId: number, timeMs: number): void; }

// Prefix on messages the operator sent directly from the native Zalo app.
const SELF_PREFIX = "📱 từ app Zalo";

// Hiển thị khi chưa lấy được tên nhóm thật (lookup lỗi) — vẫn tốt hơn tên một thành viên.
const GROUP_FALLBACK_NAME = "Nhóm Zalo";

const MEDIA_ICON: Record<MediaKind, string> = { image: "🖼️", audio: "🎙️", video: "🎥", file: "📎" };

function safeName(name: string): string {
  const cleaned = (name || "file").replace(/[/\\]/g, "_").replace(/[^\w.\-]/g, "_").replace(/^\.+$/, "file").slice(0, 120);
  return cleaned || "file";
}

function archiveKey(accountId: number, msg: IncomingMessage, filename: string): string {
  const kind = msg.kind === ZaloThreadKind.Group ? "group" : "user";
  return `${accountId}/${kind}_${msg.threadId}/${msg.msgId}_${safeName(filename)}`;
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", ogg: "audio/ogg",
  pdf: "application/pdf",
};

// Canonical extension per content-type (reverse of EXT_CONTENT_TYPE; jpg is canonical for jpeg).
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/gif": "gif", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

// Make the filename extension reflect the real content-type. Zalo's sticker `webpc` endpoint,
// for instance, serves a GIF, so a resolver-guessed ".png" would mislabel the archived file.
// Unknown content-types and already-correct extensions are left untouched.
export function alignExtension(filename: string, contentType: string): string {
  const want = CONTENT_TYPE_EXT[contentType];
  if (!want) return filename;
  const current = filename.split(".").pop()?.toLowerCase() ?? "";
  if (current === want || (want === "jpg" && current === "jpeg")) return filename;
  const base = filename.replace(/\.[A-Za-z0-9]+$/, "");
  return `${base}.${want}`;
}

function contentTypeFor(mediaType: MediaKind, filename: string, downloaded: string): string {
  if (downloaded && downloaded !== "application/octet-stream") return downloaded;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_CONTENT_TYPE[ext]) return EXT_CONTENT_TYPE[ext];
  switch (mediaType) {
    case "image": return "image/jpeg";
    case "audio": return "audio/mp4";
    case "video": return "video/mp4";
    default: return "application/octet-stream";
  }
}

// A real attachment that fails to download must NOT be silently dropped: that loses the
// media while marking the job done. Throwing lets the durable queue retry (transient
// CDN/network failures then succeed on a later attempt).
/** True when a Chatwoot call failed because the target conversation no longer exists (HTTP 404). */
function isConversationGone(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /failed[^0-9]*404/.test(m);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function downloadMedia(href: string): Promise<{ bytes: Buffer; contentType: string }> {
  // Zalo CDN video/file downloads can be slow; allow up to 60s for the body.
  const opts = { method: "GET" as const, headersTimeout: 10_000, bodyTimeout: 60_000 };
  let target = href;
  let res = await request(target, opts);
  // OA image URLs 302-redirect to the real object. undici does not follow redirects, so
  // without this we'd read the empty redirect body (0 bytes), archive it, and Chatwoot
  // would render "image no longer available". Follow up to 5 hops manually.
  let hops = 0;
  while (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
    res.body.dump();
    target = new URL(String(res.headers.location), target).toString();
    res = await request(target, opts);
    hops++;
  }
  if (res.statusCode >= 400) {
    res.body.dump();
    throw new Error(`attachment download failed (${res.statusCode}): ${href}`);
  }
  const bytes = Buffer.from(await res.body.arrayBuffer());
  // A 0-byte body is never a valid attachment; throw so the durable queue retries a
  // transient failure instead of silently archiving (and relaying) a broken image.
  if (bytes.length === 0) throw new Error(`attachment download returned an empty body: ${href}`);
  const contentType = (res.headers["content-type"] as string) ?? "application/octet-stream";
  return { bytes, contentType };
}

export class InboundHandler {
  private locks = new Map<string, Promise<unknown>>(); // per source_id serialization
  private enrichedOa = new Set<string>(); // OA contacts already backfilled this process run
  private reenrichedGroups = new Set<string>(); // group contacts already re-enriched this process run

  constructor(
    private chatwoot: ChatwootClient,
    private mapping: MappingRepo,
    private conversations: ConversationRepo,
    private enrich: EnrichFn,
    private appClientFor: AppClientFor,
    private archive: MediaArchive,
    private maxAttachmentBytes: number,
    private log: EventLog = NOOP_LOG,
    private consult?: ConsultHook,
    private infoRequest?: InfoRequestHook,
    private watermark?: WatermarkHook,
    private groupProfile?: GroupProfileResolver,
  ) {}

  async handle(accountId: number, identifier: string, msg: IncomingMessage): Promise<void> {
    const sourceId = encodeSourceId(toRoutingKindOf(msg.kind), msg.threadId);
    const key = `${identifier}:${sourceId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.process(accountId, identifier, sourceId, msg));
    this.locks.set(key, next);
    try { await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }

  private async process(accountId: number, identifier: string, sourceId: string, msg: IncomingMessage): Promise<void> {
    if (msg.isSelf) { await this.processSelf(accountId, identifier, sourceId, msg); return; }

    let conversationId = await this.resolveConversation(accountId, identifier, sourceId, msg);
    if (msg.kind === ZaloThreadKind.OaUser) this.consult?.onInbound(accountId, sourceId).catch((err) => this.log.warn({ event: "consult_failed", accountId, sourceId, err }, "consultation onInbound failed"));
    if (msg.kind === ZaloThreadKind.OaUser) this.infoRequest?.onInbound(accountId, sourceId).catch((err) => this.log.warn({ event: "info_request_failed", accountId, sourceId, err }, "info request onInbound failed"));
    const built = await this.buildOutput(accountId, msg);
    // Native reply: the public inbox API cannot set in_reply_to, so a resolvable quote is
    // routed through the Application API as an incoming message instead.
    const inReplyTo = await this.resolveQuote(accountId, msg);
    const appClient = await this.appClientFor(accountId);

    // Public inbox path, with a one-shot recreate when the Chatwoot conversation was deleted.
    const postPublicWithRecreate = async (cid: number): Promise<{ id: number }> => {
      try {
        return await this.chatwoot.createMessage(identifier, sourceId, cid, built);
      } catch (err) {
        if (!isConversationGone(err)) throw err;
        this.log.warn({ event: "conversation_recreated", accountId, sourceId, staleId: cid, err: errorMessage(err) }, "chatwoot conversation gone; recreating");
        await this.conversations.clear(accountId, sourceId);
        const conv = await this.chatwoot.createConversation(identifier, sourceId);
        await this.conversations.saveChatwootId(accountId, sourceId, conv.id);
        return await this.chatwoot.createMessage(identifier, sourceId, conv.id, built);
      }
    };

    let created: { id: number };
    if (inReplyTo != null && appClient.enabled) {
      try {
        created = await appClient.createIncomingMessage(conversationId, built.content, { inReplyTo, attachments: built.attachments });
      } catch (err) {
        // An Application API failure here is usually an account-scope 404; recreating the public
        // conversation cannot fix that. Deliver via the public inbox path instead so the message
        // still lands (only native-reply threading is lost), without entering a recreate loop.
        // (The public path may still recreate once if that conversation is genuinely gone.)
        this.log.warn({ event: "app_api_reply_fallback", accountId, sourceId, err: errorMessage(err) }, "application API reply failed; relaying without reply threading");
        created = await postPublicWithRecreate(conversationId);
      }
    } else {
      created = await postPublicWithRecreate(conversationId);
    }
    await this.mapping.recordIfNew({
      zaloAccountId: accountId, zaloMsgId: msg.msgId, zaloThreadId: msg.threadId,
      direction: "in", chatwootMessageId: created.id, quoteSrc: msg.quoteSrc,
    });
    this.log.info({ event: "inbound_relayed", accountId, sourceId, chatwootMessageId: created.id }, "inbound relayed to Chatwoot");
    if (msg.kind === ZaloThreadKind.OaUser) {
      const t = Number(msg.quoteSrc.ts);
      if (Number.isFinite(t) && t > 0) this.watermark?.onRelayed(accountId, t);
    }
  }

  // A message the operator sent directly from the native Zalo app.
  private async processSelf(accountId: number, identifier: string, sourceId: string, msg: IncomingMessage): Promise<void> {
    // Anti-loop: a known msg id means this is the echo of a message already in Chatwoot.
    if (await this.mapping.findByZaloMsgId(accountId, msg.msgId)) return;

    const conversationId = await this.resolveConversation(accountId, identifier, sourceId, msg);
    const built = await this.buildOutput(accountId, msg);
    const content = built.content ? `${SELF_PREFIX}\n${built.content}` : SELF_PREFIX;
    const inReplyTo = await this.resolveQuote(accountId, msg);
    const appClient = await this.appClientFor(accountId);

    let created: { id: number };
    try {
      created = await appClient.createOutgoingMessage(conversationId, content, built.attachments, { inReplyTo });
    } catch (err) {
      // Same recovery as the public-inbox path: the cached conversation was deleted in Chatwoot.
      // Clear the stale mapping, create a fresh conversation, and retry once.
      if (!isConversationGone(err)) throw err;
      this.log.warn({ event: "conversation_recreated", accountId, sourceId, staleId: conversationId, err: errorMessage(err) }, "chatwoot conversation gone; recreating (self)");
      await this.conversations.clear(accountId, sourceId);
      const conv = await this.chatwoot.createConversation(identifier, sourceId);
      await this.conversations.saveChatwootId(accountId, sourceId, conv.id);
      created = await appClient.createOutgoingMessage(conv.id, content, built.attachments, { inReplyTo });
    }
    await this.mapping.recordIfNew({
      zaloAccountId: accountId, zaloMsgId: msg.msgId, zaloThreadId: msg.threadId,
      direction: "out", chatwootMessageId: created.id, quoteSrc: msg.quoteSrc,
    });
  }

  // Resolve a quoted Zalo message id to the Chatwoot message it was relayed as, if known.
  private async resolveQuote(accountId: number, msg: IncomingMessage): Promise<number | undefined> {
    if (!msg.quoteMsgId) return undefined;
    const quoted = await this.mapping.findByZaloMsgId(accountId, msg.quoteMsgId);
    return quoted?.chatwootMessageId ?? undefined;
  }

  private async buildOutput(accountId: number, msg: IncomingMessage): Promise<{ content: string; attachments?: Attachment[] }> {
    const c = msg.classified;
    const prefix = this.groupSenderPrefix(msg);
    if (c.kind !== "media") return { content: prefix + c.text };

    const { bytes, contentType: downloaded } = await downloadMedia(c.href);
    const contentType = contentTypeFor(c.mediaType, c.filename, downloaded);
    const filename = alignExtension(c.filename, contentType);
    const key = archiveKey(accountId, msg, filename);
    await this.archive.put(key, bytes, contentType);

    if (bytes.length <= this.maxAttachmentBytes) {
      return { content: prefix + c.caption, attachments: [{ filename, content: bytes, contentType }] };
    }
    const mb = Math.ceil(bytes.length / (1024 * 1024));
    const url = this.archive.urlFor(key);
    return { content: prefix + `${MEDIA_ICON[c.mediaType]} ${MEDIA_LABEL[c.mediaType]} (${mb}MB) — quá lớn để hiển thị. Tải tại: ${url}` };
  }

  // In a group, every message is relayed under the single group contact, so prepend the sender's
  // name so agents can tell who said what. Skip self messages (already labelled "📱 từ app Zalo").
  private groupSenderPrefix(msg: IncomingMessage): string {
    return msg.kind === ZaloThreadKind.Group && !msg.isSelf && msg.senderName ? `**${msg.senderName}:**\n` : "";
  }

  // Resolve (creating if needed) the contact + persistent conversation for a thread.
  private async resolveConversation(accountId: number, identifier: string, sourceId: string, msg: IncomingMessage): Promise<number> {
    const existing = await this.chatwoot.getContact(identifier, sourceId);
    const enrichKey = `${identifier}:${sourceId}`;
    if (!existing) {
      await this.createContactForThread(accountId, identifier, sourceId, msg, enrichKey);
    } else if (msg.kind === ZaloThreadKind.OaUser && !this.enrichedOa.has(enrichKey)) {
      // OA contacts can't be named at create-time (no zca session); backfill name/avatar
      // once per process run for contacts that may still show the raw user id.
      this.enrichedOa.add(enrichKey);
      this.enrich(accountId, sourceId, identifier, msg.senderUid).catch(() => {});
    } else if (msg.kind === ZaloThreadKind.Group && !this.reenrichedGroups.has(enrichKey)) {
      // An existing group contact may still carry a member's name from before this fix; correct
      // it to the real group name/avatar once per process run. enrich() resolves groups from the
      // sourceId (group:<threadId>), so senderUid is passed only for signature parity.
      this.reenrichedGroups.add(enrichKey);
      this.enrich(accountId, sourceId, identifier, msg.senderUid).catch(() => {});
    }
    let conversationId = await this.conversations.getChatwootId(accountId, sourceId);
    if (!conversationId) {
      const conv = await this.chatwoot.createConversation(identifier, sourceId);
      await this.conversations.saveChatwootId(accountId, sourceId, conv.id);
      conversationId = (await this.conversations.getChatwootId(accountId, sourceId)) ?? conv.id;
    }
    return conversationId;
  }

  // Create the Chatwoot contact for a new thread. Groups are named (and avatar'd) from the group
  // info at create-time; user/OA threads keep the sender name + async enrich (as before).
  private async createContactForThread(accountId: number, identifier: string, sourceId: string, msg: IncomingMessage, enrichKey: string): Promise<void> {
    if (msg.kind === ZaloThreadKind.Group) {
      const group = await this.resolveGroupProfile(accountId, msg.threadId);
      await this.chatwoot.createContact(identifier, { sourceId, name: group?.name || GROUP_FALLBACK_NAME, avatarUrl: group?.avatar });
      // Got full info now → no immediate re-enrich. If the lookup failed, leave it unmarked so the
      // next group message re-enriches and replaces the placeholder.
      if (group) this.reenrichedGroups.add(enrichKey);
      return;
    }
    // The contact represents the thread party (= msg.threadId), never the message sender — which
    // for a self/operator-initiated message is the operator. Take the sender name as the instant
    // name only when the sender IS the thread party (an incoming, non-self message); otherwise use
    // threadId as a placeholder until enrich() resolves the party's real name.
    const instantName = (!msg.isSelf && msg.senderName) || msg.threadId;
    await this.chatwoot.createContact(identifier, { sourceId, name: instantName });
    this.enrichedOa.add(enrichKey);
    this.enrich(accountId, sourceId, identifier, msg.threadId).catch(() => {});
  }

  private async resolveGroupProfile(accountId: number, groupId: string): Promise<GroupProfile | null> {
    try {
      return (await this.groupProfile?.(accountId, groupId)) ?? null;
    } catch {
      return null;
    }
  }
}
