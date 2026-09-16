import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { OutboundHandler } from "../../src/handlers/outbound.js";
import { ZaloThreadKind } from "../../src/zalo/types.js";

let agent: MockAgent;
beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); });
afterEach(async () => { await agent.close(); });

function deps() {
  const sessions = {
    has: vi.fn(() => true),
    sendText: vi.fn(async () => ({ msgId: "z1" })),
    sendAttachment: vi.fn(async () => ({ msgId: "z2" })),
  };
  const accounts = { findByInboxIdentifier: vi.fn(async () => ({ id: 1, chatwootInboxIdentifier: "ident-1" })) };
  const inboxIndex = new Map<number, string>([[3, "ident-1"]]); // inbox_id -> identifier
  const mapping = {
    findByChatwootMessageId: vi.fn(async () => null),
    recordIfNew: vi.fn(async () => true),
  };
  return { sessions, accounts, inboxIndex, mapping };
}

describe("OutboundHandler", () => {
  it("sends a text message to the decoded zalo thread", async () => {
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:84900", content: "reply", chatwootMessageId: 1, inboxId: 3, attachments: [] });
    expect(d.sessions.sendText).toHaveBeenCalledWith(1, "84900", ZaloThreadKind.User, "reply", undefined);
  });

  it("quotes the original Zalo message when the agent replies to it", async () => {
    const d = deps();
    const quoteSrc = { uidFrom: "84900", msgId: "m1", cliMsgId: "c1", msgType: "chat.msg", ts: "1700", content: "goc", ttl: 0 };
    d.mapping.findByChatwootMessageId = vi.fn(async (id: number) => (id === 50 ? { zaloMsgId: "m1", quoteSrc } : null));
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:84900", content: "tra loi", chatwootMessageId: 2, inboxId: 3, attachments: [], inReplyTo: 50 });
    expect(d.sessions.sendText).toHaveBeenCalledWith(1, "84900", ZaloThreadKind.User, "tra loi", quoteSrc);
  });

  it("sends without a quote when the replied-to message has no stored quote source", async () => {
    const d = deps();
    d.mapping.findByChatwootMessageId = vi.fn(async (id: number) => (id === 99 ? { zaloMsgId: "m1", quoteSrc: null } : null));
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:84900", content: "tra loi", chatwootMessageId: 2, inboxId: 3, attachments: [], inReplyTo: 99 });
    expect(d.sessions.sendText).toHaveBeenCalledWith(1, "84900", ZaloThreadKind.User, "tra loi", undefined);
  });

  it("downloads and forwards an attachment", async () => {
    agent.get("http://chatwoot").intercept({ path: "/a.jpg", method: "GET" })
      .reply(200, Buffer.from("img"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({
      sourceId: "group:777", content: "see this", chatwootMessageId: 2, inboxId: 3,
      attachments: [{ dataUrl: "http://chatwoot/a.jpg", fileType: "image" }],
    });
    expect(d.sessions.sendAttachment).toHaveBeenCalledWith(
      1, "777", ZaloThreadKind.Group, expect.objectContaining({ filename: expect.any(String) }), "see this"
    );
  });

  it("no-ops when the account has no active session", async () => {
    const d = deps();
    d.sessions.has = vi.fn(() => false);
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, () => "ident-1", d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:1", content: "x", chatwootMessageId: 3, inboxId: 3, attachments: [] });
    expect(d.sessions.sendText).not.toHaveBeenCalled();
  });

  it("records the sent msg id linked to the chatwoot message id", async () => {
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:84900", content: "reply", chatwootMessageId: 11, inboxId: 3, attachments: [] });
    expect(d.mapping.recordIfNew).toHaveBeenCalledWith(expect.objectContaining({
      zaloAccountId: 1, zaloMsgId: "z1", zaloThreadId: "84900", direction: "out", chatwootMessageId: 11,
    }));
  });

  it("skips sending when the chatwoot message originated from a Zalo native send", async () => {
    const d = deps();
    d.mapping.findByChatwootMessageId = vi.fn(async () => ({ zaloMsgId: "z-native" }));
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot");
    await h.handle({ sourceId: "user:84900", content: "echo", chatwootMessageId: 12, inboxId: 3, attachments: [] });
    expect(d.sessions.sendText).not.toHaveBeenCalled();
  });

  it("rewrites the attachment data_url origin to the internal chatwoot base before downloading", async () => {
    // The webhook delivers a FRONTEND_URL (localhost) data_url; the bridge must fetch
    // it from the internal host instead.
    agent.get("http://chatwoot-rails:3000").intercept({ path: "/rails/active_storage/x.jpg", method: "GET" })
      .reply(200, Buffer.from("img"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot-rails:3000");
    await h.handle({
      sourceId: "user:84900", content: "pic", chatwootMessageId: 7, inboxId: 3,
      attachments: [{ dataUrl: "http://localhost:3000/rails/active_storage/x.jpg", fileType: "image" }],
    });
    expect(d.sessions.sendAttachment).toHaveBeenCalled();
  });

  it("follows the Chatwoot blobs/redirect 302 to fetch the real attachment bytes", async () => {
    const pool = agent.get("http://chatwoot-rails:3000");
    pool.intercept({ path: "/rails/active_storage/blobs/redirect/sig/p.jpg", method: "GET" })
      .reply(302, "", { headers: { location: "http://localhost:3000/rails/active_storage/disk/sig/p.jpg" } });
    pool.intercept({ path: "/rails/active_storage/disk/sig/p.jpg", method: "GET" })
      .reply(200, Buffer.from("realbytes"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot-rails:3000");
    await h.handle({
      sourceId: "user:84900", content: "pic", chatwootMessageId: 8, inboxId: 3,
      attachments: [{ dataUrl: "http://localhost:3000/rails/active_storage/blobs/redirect/sig/p.jpg", fileType: "image" }],
    });
    const call = d.sessions.sendAttachment.mock.calls[0];
    expect(call).toBeTruthy();
    // 4th arg is the file { filename, data } — data must be the real bytes from the disk URL, not the empty 302 body.
    expect(call[3].data.toString()).toBe("realbytes");
  });

  it("does not rewrite a redirect that points to a different external storage origin (e.g. S3)", async () => {
    // Reproduces chatwoot.minastik.com: ActiveStorage backed by S3, whose blobs/redirect
    // 302s to a presigned S3 URL on a completely different host+query string.
    const pool = agent.get("http://chatwoot-rails:3000");
    pool.intercept({ path: "/rails/active_storage/blobs/redirect/sig/p.jpg", method: "GET" })
      .reply(302, "", { headers: { location: "https://cdn.example-storage.com/bucket/obj?X-Amz-Signature=abc123" } });
    // If the host-rewrite bug regresses, the S3 redirect gets its host swapped back to
    // chatwoot-rails:3000 and this stray path is hit instead — Chatwoot's own server would
    // 404 on it, exactly like the real chatwoot.minastik.com case.
    pool.intercept({ path: "/bucket/obj?X-Amz-Signature=abc123", method: "GET" })
      .reply(404, "not found");
    agent.get("https://cdn.example-storage.com").intercept({ path: "/bucket/obj?X-Amz-Signature=abc123", method: "GET" })
      .reply(200, Buffer.from("s3bytes"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot-rails:3000");
    await h.handle({
      sourceId: "user:84900", content: "pic", chatwootMessageId: 9, inboxId: 3,
      attachments: [{ dataUrl: "http://chatwoot-rails:3000/rails/active_storage/blobs/redirect/sig/p.jpg", fileType: "image" }],
    });
    const call = d.sessions.sendAttachment.mock.calls[0];
    expect(call).toBeTruthy();
    expect(call[3].data.toString()).toBe("s3bytes");
  });

  it("posts an agent note and does not retry when OA reports an out-of-window send", async () => {
    const d = deps();
    const { OaWindowError } = await import("../../src/zalo-oa/sender.js");
    d.sessions.sendText = vi.fn(async () => { throw new OaWindowError("blocked"); });
    const onWindowBlocked = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", onWindowBlocked);
    await h.handle({ sourceId: "user:84900", content: "hi", chatwootMessageId: 7, inboxId: 3, attachments: [] });
    expect(onWindowBlocked).toHaveBeenCalledTimes(1);
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });

  it("notifies and drops (no retry) when the account has no active session", async () => {
    const d = deps();
    d.sessions.has = vi.fn(() => false);
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, () => "ident-1", d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:1", content: "x", chatwootMessageId: 3, inboxId: 3, attachments: [] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toMatch(/mất kết nối/);
    expect(d.sessions.sendText).not.toHaveBeenCalled();
  });

  it("notifies with the filename and does NOT throw when Zalo rejects a file", async () => {
    agent.get("http://chatwoot").intercept({ path: "/bad.exe", method: "GET" })
      .reply(200, Buffer.from("bin"), { headers: { "content-type": "application/octet-stream" } });
    const d = deps();
    const { ZaloFileRejectedError } = await import("../../src/zalo/types.js");
    d.sessions.sendAttachment = vi.fn(async () => { throw new ZaloFileRejectedError("bad.exe", "rejected"); });
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 5, inboxId: 3, attachments: [{ dataUrl: "http://chatwoot/bad.exe", fileType: "file" }] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toContain("bad.exe");
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });

  it("still attempts the remaining attachments after one is rejected", async () => {
    const pool = agent.get("http://chatwoot");
    pool.intercept({ path: "/bad.exe", method: "GET" }).reply(200, Buffer.from("bin"), { headers: { "content-type": "application/octet-stream" } });
    pool.intercept({ path: "/ok.jpg", method: "GET" }).reply(200, Buffer.from("img"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const { ZaloFileRejectedError } = await import("../../src/zalo/types.js");
    let call = 0;
    d.sessions.sendAttachment = vi.fn(async () => { call++; if (call === 1) throw new ZaloFileRejectedError("bad.exe", "rejected"); return { msgId: "z9" }; });
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 6, inboxId: 3, attachments: [
      { dataUrl: "http://chatwoot/bad.exe", fileType: "file" },
      { dataUrl: "http://chatwoot/ok.jpg", fileType: "image" },
    ] });
    expect(d.sessions.sendAttachment).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(d.mapping.recordIfNew).toHaveBeenCalledTimes(1); // only the successful one
  });

  it("notifies and does NOT throw when an attachment download returns 4xx (permanent)", async () => {
    agent.get("http://chatwoot").intercept({ path: "/gone.jpg", method: "GET" }).reply(404, "");
    const d = deps();
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 9, inboxId: 3, attachments: [{ dataUrl: "http://chatwoot/gone.jpg", fileType: "image" }] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toMatch(/không tải được/i);
    expect(d.sessions.sendAttachment).not.toHaveBeenCalled();
  });

  it("throws (so the queue retries) when an attachment download returns 5xx (transient)", async () => {
    agent.get("http://chatwoot").intercept({ path: "/oops.jpg", method: "GET" }).reply(503, "");
    const d = deps();
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await expect(h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 10, inboxId: 3, attachments: [{ dataUrl: "http://chatwoot/oops.jpg", fileType: "image" }] }))
      .rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });

  it("archives the file and sends the customer a download link when Zalo rejects it", async () => {
    agent.get("http://chatwoot").intercept({ path: "/big.pdf", method: "GET" })
      .reply(200, Buffer.from("PDFBYTES"), { headers: { "content-type": "application/pdf" } });
    const d = deps();
    const { ZaloFileRejectedError } = await import("../../src/zalo/types.js");
    d.sessions.sendAttachment = vi.fn(async () => { throw new ZaloFileRejectedError("big.pdf", "too large"); });
    const notify = vi.fn(async () => {});
    const archive = { put: vi.fn(async () => {}), urlFor: vi.fn(() => "http://pub/media/tok"), getStream: vi.fn() };
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify, archive as any);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 21, inboxId: 3, attachments: [{ dataUrl: "http://chatwoot/big.pdf", fileType: "file" }] });
    expect(archive.put).toHaveBeenCalledTimes(1);
    expect(d.sessions.sendText).toHaveBeenCalledTimes(1);
    expect(String(d.sessions.sendText.mock.calls[0][3])).toContain("http://pub/media/tok");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toMatch(/đã gửi link/);
    expect(d.mapping.recordIfNew).toHaveBeenCalledTimes(1); // the link message is recorded
  });

  it("falls back to the agent note when the customer link message also fails", async () => {
    agent.get("http://chatwoot").intercept({ path: "/big.pdf", method: "GET" })
      .reply(200, Buffer.from("PDFBYTES"), { headers: { "content-type": "application/pdf" } });
    const d = deps();
    const { ZaloFileRejectedError } = await import("../../src/zalo/types.js");
    const { OaWindowError } = await import("../../src/zalo-oa/sender.js");
    d.sessions.sendAttachment = vi.fn(async () => { throw new ZaloFileRejectedError("big.pdf", "too large"); });
    d.sessions.sendText = vi.fn(async () => { throw new OaWindowError("blocked"); });
    const notify = vi.fn(async () => {});
    const archive = { put: vi.fn(async () => {}), urlFor: vi.fn(() => "http://pub/media/tok"), getStream: vi.fn() };
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify, archive as any);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 22, inboxId: 3, attachments: [{ dataUrl: "http://chatwoot/big.pdf", fileType: "file" }] });
    expect(archive.put).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toMatch(/Không gửi được tệp/);
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });

  it("notifies and does NOT retry when a text send is permanently rejected by Zalo", async () => {
    const d = deps();
    const { OaPermanentError } = await import("../../src/zalo-oa/sender.js");
    d.sessions.sendText = vi.fn(async () => { throw new OaPermanentError(-211, "OA send failed: -211 Out of quota"); });
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:84900", content: "hi", chatwootMessageId: 31, inboxId: 3, attachments: [] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toContain("Out of quota");
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });

  it("notifies and keeps going when an attachment send is permanently rejected", async () => {
    const pool = agent.get("http://chatwoot");
    pool.intercept({ path: "/a.jpg", method: "GET" }).reply(200, Buffer.from("img"), { headers: { "content-type": "image/jpeg" } });
    pool.intercept({ path: "/b.jpg", method: "GET" }).reply(200, Buffer.from("img"), { headers: { "content-type": "image/jpeg" } });
    const d = deps();
    const { OaPermanentError } = await import("../../src/zalo-oa/sender.js");
    let call = 0;
    d.sessions.sendAttachment = vi.fn(async () => { call++; if (call === 1) throw new OaPermanentError(-248, "OA send failed: -248 policy"); return { msgId: "z9" }; });
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await h.handle({ sourceId: "user:84900", content: "", chatwootMessageId: 32, inboxId: 3, attachments: [
      { dataUrl: "http://chatwoot/a.jpg", fileType: "image" },
      { dataUrl: "http://chatwoot/b.jpg", fileType: "image" },
    ] });
    expect(d.sessions.sendAttachment).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][1])).toContain("policy");
    expect(d.mapping.recordIfNew).toHaveBeenCalledTimes(1); // only the successful attachment
  });

  it("passes the error to onWindowBlocked so the window note can show the reason", async () => {
    const d = deps();
    const { OaWindowError } = await import("../../src/zalo-oa/sender.js");
    d.sessions.sendText = vi.fn(async () => { throw new OaWindowError("OA send failed: -230 no interaction in 7 days"); });
    const onWindowBlocked = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", onWindowBlocked);
    await h.handle({ sourceId: "user:84900", content: "hi", chatwootMessageId: 33, inboxId: 3, attachments: [] });
    expect(onWindowBlocked).toHaveBeenCalledTimes(1);
    expect(String(onWindowBlocked.mock.calls[0][1])).toContain("-230");
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });

  it("propagates a transient OaSendError so the queue retries (no notify)", async () => {
    const d = deps();
    const { OaSendError } = await import("../../src/zalo-oa/sender.js");
    d.sessions.sendText = vi.fn(async () => { throw new OaSendError(-32, "OA send failed: -32 rate limit"); });
    const notify = vi.fn(async () => {});
    const h = new OutboundHandler(d.sessions as any, d.accounts as any, (id) => d.inboxIndex.get(id) ?? null, d.mapping as any, "http://chatwoot", undefined, undefined, undefined, notify);
    await expect(h.handle({ sourceId: "user:84900", content: "hi", chatwootMessageId: 34, inboxId: 3, attachments: [] }))
      .rejects.toBeInstanceOf(OaSendError);
    expect(notify).not.toHaveBeenCalled();
    expect(d.mapping.recordIfNew).not.toHaveBeenCalled();
  });
});
