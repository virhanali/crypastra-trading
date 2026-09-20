import type { ApiClient } from "./client.js";
import type { OrderDto } from "./types.js";
import type { OrderIntent } from "../trade/intent.js";
export class OrdersApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  async list(accountId: string, options: { status?: string; limit?: number } = {}): Promise<OrderDto[]> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.status !== undefined) {
      query.set("status", options.status);
    }
    const response = await this.#client.get<{ orders: OrderDto[] }>(
      `/accounts/${encodeURIComponent(accountId)}/orders?${query.toString()}`,
    );
    return response.orders;
  }

  /**
   * Kirim order PAPER. `commandId` dipakai ulang saat retry aksi yang sama;
   * backend memakai `request_hash` untuk mendeteksi payload yang berbeda.
   */
  submit(
    accountId: string,
    input: OrderIntent & { commandId: string },
  ): Promise<{ order: OrderDto; fills: unknown[]; duplicate: boolean }> {
    return this.#client.post(`/accounts/${encodeURIComponent(accountId)}/orders`, {
      commandId: input.commandId,
      contract: input.contract,
      side: input.side,
      type: input.type,
      // Size dikirim sebagai cacah kontrak (string digit), bukan nilai format.
      size: String(input.size),
      leverage: input.leverage,
      limitPrice: input.price,
      takeProfitPrice: input.tpPrice,
      stopLossPrice: input.slPrice,
      timeInForce: input.timeInForce,
      reduceOnly: input.reduceOnly,
    });
  }

  cancel(accountId: string, orderId: string, input: { commandId: string; reason?: string }): Promise<{ order: OrderDto; duplicate: boolean }> {
    return this.#client.post(
      `/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}/cancel`,
      { commandId: input.commandId, ...(input.reason === undefined ? {} : { reason: input.reason }) },
    );
  }
}
