import { request } from "undici";
import type { Attachment } from "./client.js";
import { buildMultipart } from "./multipart.js";
import { CHATWOOT_TIMEOUTS } from "./client.js";

export class ChatwootAppClient {
  constructor(
    private baseUrl: string,
    private accessToken: string | null,
    private accountId: number | null
  ) {}

  get enabled(): boolean {
    return Boolean(this.accessToken && this.accountId);
  }

  async postPrivateNote(conversationId: number, content: string, opts: { inReplyTo?: number } = {}): Promise<void> {
    if (!this.enabled) return; // graceful no-op when not configured
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
    const payload: Record<string, unknown> = { content, message_type: "outgoing", private: true };
    if (opts.inReplyTo != null) payload.content_attributes = { in_reply_to: opts.inReplyTo };
    const res = await request(url, {
      ...CHATWOOT_TIMEOUTS, method: "POST",
      headers: { "content-type": "application/json", api_access_token: this.accessToken as string },
      body: JSON.stringify(payload),
    });
    if (res.statusCode >= 400) { res.body.dump(); throw new Error(`postPrivateNote failed: ${res.statusCode}`); }
    res.body.dump();
  }

  /**
   * Create an OUTGOING (agent-side), non-private message in a conversation via the
   * Application API. Used to import messages the operator sent directly from the
   * native Zalo app. Throws when not configured so the durable queue retries rather
   * than silently dropping the message.
   */
  async createOutgoingMessage(
    conversationId: number,
    content: string,
    attachments?: Attachment[],
    opts: { inReplyTo?: number } = {},
  ): Promise<{ id: number }> {
    return this.postMessage(conversationId, { content, messageType: "outgoing", attachments, inReplyTo: opts.inReplyTo });
  }

  /**
   * Create an INCOMING (customer-side) message via the Application API. Unlike the public
   * inbox API, this path accepts `content_attributes.in_reply_to`, so it is used when a Zalo
   * message quotes another and we can resolve the quoted Chatwoot message id (native reply).
   */
  async createIncomingMessage(
    conversationId: number,
    content: string,
    opts: { inReplyTo?: number; attachments?: Attachment[] } = {},
  ): Promise<{ id: number }> {
    return this.postMessage(conversationId, { content, messageType: "incoming", attachments: opts.attachments, inReplyTo: opts.inReplyTo });
  }

  /** Delete a Chatwoot message (used when the operator recalls their own Zalo message). */
  async deleteMessage(conversationId: number, messageId: number): Promise<void> {
    if (!this.enabled) {
      throw new Error("ChatwootAppClient not configured (CHATWOOT_API_ACCESS_TOKEN / CHATWOOT_ACCOUNT_ID)");
    }
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages/${messageId}`;
    const res = await request(url, {
      ...CHATWOOT_TIMEOUTS, method: "DELETE",
      headers: { api_access_token: this.accessToken as string },
    });
    if (res.statusCode >= 400) { res.body.dump(); throw new Error(`deleteMessage failed: ${res.statusCode}`); }
    res.body.dump();
  }

  private async postMessage(
    conversationId: number,
    opts: { content: string; messageType: "incoming" | "outgoing"; attachments?: Attachment[]; inReplyTo?: number },
  ): Promise<{ id: number }> {
    if (!this.enabled) {
      throw new Error("ChatwootAppClient not configured (CHATWOOT_API_ACCESS_TOKEN / CHATWOOT_ACCOUNT_ID)");
    }
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
    const token = this.accessToken as string;
    const { content, messageType, attachments, inReplyTo } = opts;

    if (attachments && attachments.length > 0) {
      const fields: Record<string, string> = { content, message_type: messageType, private: "false" };
      if (inReplyTo != null) fields["content_attributes[in_reply_to]"] = String(inReplyTo);
      const { body, contentType } = buildMultipart(
        fields,
        attachments.map((a) => ({ name: "attachments[]", filename: a.filename, contentType: a.contentType, content: a.content })),
      );
      const res = await request(url, {
        ...CHATWOOT_TIMEOUTS, method: "POST",
        headers: { "content-type": contentType, "content-length": String(body.length), api_access_token: token },
        body,
      });
      if (res.statusCode >= 400) { res.body.dump(); throw new Error(`postMessage(attachment) failed: ${res.statusCode}`); }
      return (await res.body.json()) as { id: number };
    }

    const payload: Record<string, unknown> = { content, message_type: messageType, private: false };
    if (inReplyTo != null) payload.content_attributes = { in_reply_to: inReplyTo };
    const res = await request(url, {
      ...CHATWOOT_TIMEOUTS, method: "POST",
      headers: { "content-type": "application/json", api_access_token: token },
      body: JSON.stringify(payload),
    });
    if (res.statusCode >= 400) { res.body.dump(); throw new Error(`postMessage failed: ${res.statusCode}`); }
    return (await res.body.json()) as { id: number };
  }
}
