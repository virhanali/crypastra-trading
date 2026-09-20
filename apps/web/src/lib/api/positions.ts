import type { ApiClient } from "./client.js";
import type { PositionDto } from "./types.js";

export class PositionsApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  async list(accountId: string, options: { limit?: number } = {}): Promise<PositionDto[]> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
    const response = await this.#client.get<{ positions: PositionDto[] }>(
      `/accounts/${encodeURIComponent(accountId)}/positions?${query.toString()}`,
    );
    return response.positions;
  }

  /**
   * Tutup posisi (penuh) dengan kutipan eksekusi dari server.
   * `bidPrice`/`askPrice` opsional; bila dihilangkan server memakai bukunya.
   */
  close(
    accountId: string,
    positionId: string,
    input: { commandId: string; bidPrice?: string; askPrice?: string; reason?: "manual" },
  ): Promise<{ position: PositionDto; settlement: Record<string, unknown> }> {
    return this.#client.post(
      `/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}/close`,
      {
        commandId: input.commandId,
        ...(input.bidPrice === undefined ? {} : { bidPrice: input.bidPrice }),
        ...(input.askPrice === undefined ? {} : { askPrice: input.askPrice }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    );
  }

  /**
   * Ubah TP/SL posisi terbuka.
   * `undefined` = pertahankan nilai lama, `null` = kosongkan, string = set baru.
   */
  amendProtection(
    accountId: string,
    positionId: string,
    input: { commandId: string; takeProfitPrice?: string | null; stopLossPrice?: string | null },
  ): Promise<{ position: PositionDto; duplicate: boolean }> {
    return this.#client.patch(
      `/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}/protection`,
      {
        commandId: input.commandId,
        ...(input.takeProfitPrice === undefined ? {} : { takeProfitPrice: input.takeProfitPrice }),
        ...(input.stopLossPrice === undefined ? {} : { stopLossPrice: input.stopLossPrice }),
      },
    );
  }

  async get(accountId: string, positionId: string): Promise<PositionDto> {
    const response = await this.#client.get<{ position: PositionDto }>(
      `/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}`,
    );
    return response.position;
  }
}
