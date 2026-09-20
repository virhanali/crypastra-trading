import type { ApiClient } from "./client.js";
import type { FillDto, HistoryEntryDto, LedgerEntryDto } from "./types.js";

/** Fill, riwayat posisi, dan ledger — semuanya berpaginasi kursor. */
export class HistoryApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  async fills(accountId: string, options: { limit?: number; after?: string | null } = {}): Promise<{ items: FillDto[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.after != null) {
      query.set("after", options.after);
    }
    const response = await this.#client.get<{ fills: FillDto[]; nextCursor: string | null }>(
      `/accounts/${encodeURIComponent(accountId)}/fills?${query.toString()}`,
    );
    return { items: response.fills, nextCursor: response.nextCursor };
  }

  async history(accountId: string, options: { limit?: number; after?: string | null } = {}): Promise<{ items: HistoryEntryDto[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.after != null) {
      query.set("after", options.after);
    }
    const response = await this.#client.get<{ positions: HistoryEntryDto[]; nextCursor: string | null }>(
      `/accounts/${encodeURIComponent(accountId)}/history?${query.toString()}`,
    );
    return { items: response.positions, nextCursor: response.nextCursor };
  }

  async ledger(accountId: string, options: { limit?: number; after?: number } = {}): Promise<{ items: LedgerEntryDto[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.after !== undefined) {
      query.set("after", String(options.after));
    }
    const response = await this.#client.get<{ entries: LedgerEntryDto[]; nextCursor: string | null }>(
      `/accounts/${encodeURIComponent(accountId)}/ledger?${query.toString()}`,
    );
    return { items: response.entries, nextCursor: response.nextCursor };
  }
}
