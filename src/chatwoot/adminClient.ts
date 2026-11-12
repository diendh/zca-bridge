import { request } from "undici";
import { CHATWOOT_TIMEOUTS } from "./client.js";

export type ChatwootAdminErrorCode =
  | "chatwoot_config_missing"
  | "chatwoot_auth_failed"
  | "chatwoot_accounts_list_failed";

export class ChatwootAdminError extends Error {
  constructor(
    public code: ChatwootAdminErrorCode,
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "ChatwootAdminError";
  }
}

export interface ChatwootAccount {
  id: number;
  name: string;
}

export class ChatwootAdminClient {
  constructor(
    private baseUrl: string,
    private accessToken: string | null,
  ) {}

  async listAccounts(): Promise<ChatwootAccount[]> {
    const baseUrl = this.baseUrl?.replace(/\/$/, "");
    if (!baseUrl || !this.accessToken) {
      throw new ChatwootAdminError("chatwoot_config_missing", "Chatwoot base URL and API access token are required");
    }
    const res = await request(`${baseUrl}/api/v1/profile`, {
      ...CHATWOOT_TIMEOUTS, method: "GET",
      headers: { api_access_token: this.accessToken },
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.body.dump();
      throw new ChatwootAdminError("chatwoot_auth_failed", `Chatwoot auth failed: ${res.statusCode}`, res.statusCode);
    }
    if (res.statusCode >= 400) {
      res.body.dump();
      throw new ChatwootAdminError("chatwoot_accounts_list_failed", `Chatwoot list accounts failed: ${res.statusCode}`, res.statusCode);
    }
    const body = (await res.body.json()) as any;
    const rows = Array.isArray(body?.accounts) ? body.accounts : [];
    return rows
      .filter((a: any) => a?.role === "administrator")
      .map((a: any) => ({ id: Number(a?.id), name: String(a?.name ?? "") }))
      .filter((a: ChatwootAccount) => Number.isFinite(a.id) && a.id > 0);
  }
}
