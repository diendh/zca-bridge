import { describe, it, expect, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { InboundHandler } from "../../src/handlers/inbound.js";
import { ZaloThreadKind, IncomingMessage } from "../../src/zalo/types.js";
import type { ClassifiedMessage } from "../../src/zalo/classify.js";
import type { MediaArchive } from "../../src/media/archive.js";

function deps() {
  const chatwoot = {
    getContact: vi.fn(async () => null),
    createContact: vi.fn(async () => ({ sourceId: "user:84900" })),
    createConversation: vi.fn(async () => ({ id: 42 })),
    createMessage: vi.fn(async () => ({ id: 1001 })),
  };
  const mapping = {
    recordIfNew: vi.fn(async () => true),
    findByZaloMsgId: vi.fn(async () => null),
  };
  const appClient = {
    enabled: true,
    createOutgoingMessage: vi.fn(async () => ({ id: 2001 })),
    createIncomingMessage: vi.fn(async () => ({ id: 2002 })),
  };
  const store = new Map<string, number>();
  const conversations = {
    getChatwootId: vi.fn(async (accId: number, sid: string) => store.get(`${accId}:${sid}`) ?? null),
    saveChatwootId: vi.fn(async (accId: number, sid: string, id: number) => { if (!store.has(`${accId}:${sid}`)) store.set(`${accId}:${sid}`, id); }),
    clear: vi.fn(async (accId: number, sid: string) => { store.delete(`${accId}:${sid}`); }),
  };
  const enrich = vi.fn(async () => {});
  const archive = {
    put: vi.fn(async () => {}),
    getStream: vi.fn(async () => null),
    urlFor: vi.fn(() => "https://bridge.test/media/tok123"),
  } as unknown as MediaArchive & { put: any; urlFor: any };
  return { chatwoot, mapping, conversations, enrich, appClient, archive };
}

const CAP = 40 * 1024 * 1024;

function make(d: ReturnType<typeof deps>, cap = CAP) {
  return new InboundHandler(
    d.chatwoot as any, d.mapping as any, d.conversations as any, d.enrich, (async () => d.appClient) as any, d.archive, cap,
  );
}

const textClassified: ClassifiedMessage = { kind: "text", text: "xin chao" };
const baseMsg: IncomingMessage = {
  kind: ZaloThreadKind.User, threadId: "84900", msgId: "m1",
  senderUid: "84900", senderName: "Khach A", text: "xin chao", classified: textClassified, isSelf: false,
};

describe("InboundHandler", () => {
  it("creates contact, conversation, and message for a new thread", async () => {
    const d = deps();
    await make(d).handle(1, "ident-1", baseMsg);
    expect(d.chatwoot.createContact).toHaveBeenCalledWith("ident-1", expect.objectContaining({ sourceId: "user:84900" }));
    expect(d.chatwoot.createConversation).toHaveBeenCalledWith("ident-1", "user:84900");
    expect(d.chatwoot.createMessage).toHaveBeenCalledWith("ident-1", "user:84900", 42, expect.objectContaining({ content: "xin chao" }));
    expect(d.conversations.saveChatwootId).toHaveBeenCalledWith(1, "user:84900", 42);
    expect(d.mapping.recordIfNew).toHaveBeenCalled();
  });

  it("imports a self message as a labelled outgoing message", async () => {
    const d = deps();
    await make(d).handle(1, "ident-1", { ...baseMsg, isSelf: true, text: "tra loi tu app", classified: { kind: "text", text: "tra loi tu app" } });
    expect(d.chatwoot.createMessage).not.toHaveBeenCalled();
    expect(d.appClient.createOutgoingMessage).toHaveBeenCalledWith(42, "📱 từ app Zalo\ntra loi tu app", undefined, { inReplyTo: undefined });
    expect(d.mapping.recordIfNew).toHaveBeenCalledWith(expect.objectContaining({ direction: "out", chatwootMessageId: 2001 }));
  });

  it("recreates the conversation and retries a self-message when the cached conversation is gone (404)", async () => {
    const d = deps();
    d.chatwoot.getContact = vi.fn(async () => ({ sourceId: "user:84900" }));
    // Pre-seed the cache with a stale conversation id, as if it were created earlier and then
    // deleted from Chatwoot directly (the bridge never proactively re-validates its cache).
    await d.conversations.saveChatwootId(1, "user:84900", 42);
    d.chatwoot.createConversation = vi.fn(async () => ({ id: 99 }));
    d.appClient.createOutgoingMessage = vi.fn()
      .mockRejectedValueOnce(new Error("postMessage failed: 404"))
      .mockResolvedValueOnce({ id: 3001 });

    await make(d).handle(1, "ident-1", {
      ...baseMsg, isSelf: true, text: "tin nhan tu app", classified: { kind: "text", text: "tin nhan tu app" },
    });

    expect(d.conversations.clear).toHaveBeenCalledWith(1, "user:84900");
    expect(d.chatwoot.createConversation).toHaveBeenCalledWith("ident-1", "user:84900");
    expect(d.appClient.createOutgoingMessage).toHaveBeenNthCalledWith(
      2, 99, expect.stringContaining("tin nhan tu app"), undefined, { inReplyTo: undefined },
    );
    expect(d.mapping.recordIfNew).toHaveBeenCalledWith(expect.objectContaining({ direction: "out", chatwootMessageId: 3001 }));
  });

  it("skips a self message that is an echo of a Chatwoot-originated send", async () => {
    const d = deps();
    d.mapping.findByZaloMsgId = vi.fn(async () => ({ chatwootMessageId: 500, direction: "out" as const }));
    await make(d).handle(1, "ident-1", { ...baseMsg, isSelf: true });
    expect(d.appClient.createOutgoingMessage).not.toHaveBeenCalled();
    expect(d.chatwoot.createMessage).not.toHaveBeenCalled();
  });

  it("renders a non-media fallback (location) as a text message", async () => {
    const d = deps();
    const classified: ClassifiedMessage = { kind: "fallback", text: "📍 Vị trí: https://www.google.com/maps?q=10,106" };
    await make(d).handle(1, "ident-1", { ...baseMsg, text: classified.text, classified });
    expect(d.chatwoot.createMessage).toHaveBeenCalledWith("ident-1", "user:84900", 42, { content: "📍 Vị trí: https://www.google.com/maps?q=10,106" });
    expect(d.archive.put).not.toHaveBeenCalled();
  });

  it("downloads, archives, and attaches small media", async () => {
    const prev = getGlobalDispatcher();
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    mock.get("https://cdn.zalo.test").intercept({ path: "/v.m4a", method: "GET" })
      .reply(200, Buffer.from("audiobytes"), { headers: { "content-type": "audio/mp4" } });
    try {
      const d = deps();
      const classified: ClassifiedMessage = { kind: "media", mediaType: "audio", href: "https://cdn.zalo.test/v.m4a", filename: "v.m4a", caption: "" };
      await make(d).handle(1, "ident-1", { ...baseMsg, text: "", classified });
      expect(d.archive.put).toHaveBeenCalledWith("1/user_84900/m1_v.m4a", expect.any(Buffer), "audio/mp4");
      const call = d.chatwoot.createMessage.mock.calls[0][3];
      expect(call.attachments[0]).toMatchObject({ filename: "v.m4a", contentType: "audio/mp4" });
    } finally {
      await mock.close(); setGlobalDispatcher(prev);
    }
  });

  it("archives oversized media and posts a text link instead of attaching", async () => {
    const prev = getGlobalDispatcher();
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    const big = Buffer.alloc(5); // 5 bytes, cap set to 1 below
    mock.get("https://cdn.zalo.test").intercept({ path: "/big.mp4", method: "GET" })
      .reply(200, big, { headers: { "content-type": "video/mp4" } });
    try {
      const d = deps();
      const classified: ClassifiedMessage = { kind: "media", mediaType: "video", href: "https://cdn.zalo.test/big.mp4", filename: "big.mp4", caption: "" };
      await make(d, 1).handle(1, "ident-1", { ...baseMsg, text: "", classified });
      expect(d.archive.put).toHaveBeenCalledWith("1/user_84900/m1_big.mp4", expect.any(Buffer), "video/mp4");
      const call = d.chatwoot.createMessage.mock.calls[0][3];
      expect(call.attachments).toBeUndefined();
      expect(call.content).toContain("https://bridge.test/media/tok123");
      expect(call.content).toContain("quá lớn");
    } finally {
      await mock.close(); setGlobalDispatcher(prev);
    }
  });

  it("throws (so the queue retries) when a real attachment fails to download", async () => {
    const prev = getGlobalDispatcher();
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    mock.get("https://cdn.zalo.test").intercept({ path: "/img.jpg", method: "GET" }).reply(500, "");
    try {
      const d = deps();
      const classified: ClassifiedMessage = { kind: "media", mediaType: "image", href: "https://cdn.zalo.test/img.jpg", filename: "img.jpg", caption: "" };
      await expect(make(d).handle(1, "ident-1", { ...baseMsg, text: "", classified }))
        .rejects.toThrow(/attachment download failed/);
      expect(d.chatwoot.createMessage).not.toHaveBeenCalled();
    } finally {
      await mock.close(); setGlobalDispatcher(prev);
    }
  });

  it("reuses the persisted conversation for a second message from the same thread", async () => {
    const d = deps();
    d.chatwoot.getContact = vi.fn(async () => ({ sourceId: "user:84900" }));
    const h = make(d);
    await h.handle(1, "ident-1", baseMsg);
    await h.handle(1, "ident-1", { ...baseMsg, msgId: "m2", text: "again", classified: { kind: "text", text: "again" } });
    expect(d.chatwoot.createConversation).toHaveBeenCalledTimes(1);
    expect(d.chatwoot.createMessage).toHaveBeenCalledTimes(2);
  });

  it("routes a quoted reply through the app API with in_reply_to when the quoted message is known", async () => {
    const d = deps();
    d.chatwoot.getContact = vi.fn(async () => ({ sourceId: "user:84900" }));
    d.mapping.findByZaloMsgId = vi.fn(async () => ({ chatwootMessageId: 1500, direction: "in" as const }));
    await make(d).handle(1, "ident-1", { ...baseMsg, msgId: "m9", text: "tra loi", classified: { kind: "text", text: "tra loi" }, quoteMsgId: "m1" });
    expect(d.appClient.createIncomingMessage).toHaveBeenCalledWith(42, "tra loi", { inReplyTo: 1500, attachments: undefined });
    expect(d.chatwoot.createMessage).not.toHaveBeenCalled();
  });

  it("falls back to the public API when the quoted message is unknown", async () => {
    const d = deps();
    d.chatwoot.getContact = vi.fn(async () => ({ sourceId: "user:84900" }));
    d.mapping.findByZaloMsgId = vi.fn(async () => null); // quoted message not in the map
    await make(d).handle(1, "ident-1", { ...baseMsg, text: "tra loi", classified: { kind: "text", text: "tra loi" }, quoteMsgId: "gone" });
    expect(d.appClient.createIncomingMessage).not.toHaveBeenCalled();
    expect(d.chatwoot.createMessage).toHaveBeenCalled();
  });

  it("archives and imports operator self-sent media as an outgoing attachment", async () => {
    const prev = getGlobalDispatcher();
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    mock.get("https://cdn.zalo.test").intercept({ path: "/selfie.jpg", method: "GET" })
      .reply(200, Buffer.from("imgbytes"), { headers: { "content-type": "image/jpeg" } });
    try {
      const d = deps();
      const classified: ClassifiedMessage = { kind: "media", mediaType: "image", href: "https://cdn.zalo.test/selfie.jpg", filename: "selfie.jpg", caption: "" };
      await make(d).handle(1, "ident-1", { ...baseMsg, isSelf: true, text: "", classified });
      expect(d.archive.put).toHaveBeenCalledWith("1/user_84900/m1_selfie.jpg", expect.any(Buffer), "image/jpeg");
      expect(d.chatwoot.createMessage).not.toHaveBeenCalled();
      const call = d.appClient.createOutgoingMessage.mock.calls[0];
      expect(call[0]).toBe(42);                       // conversationId
      expect(call[1]).toBe("📱 từ app Zalo");          // prefix only (empty caption → no trailing newline)
      expect(call[2][0]).toMatchObject({ filename: "selfie.jpg", contentType: "image/jpeg" });
      expect(d.mapping.recordIfNew).toHaveBeenCalledWith(expect.objectContaining({ direction: "out" }));
    } finally {
      await mock.close(); setGlobalDispatcher(prev);
    }
  });
});
