import type { ApiClient } from "./client.js";
import type { CandleResponseDto, MarketHealthResponseDto, MarketStateResponseDto } from "./types.js";

export class MarketApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  state(contracts: readonly string[]): Promise<MarketStateResponseDto> {
    const query = new URLSearchParams({ contracts: contracts.join(",") });
    return this.#client.get(`/market/state?${query.toString()}`);
  }

  candles(contract: string, interval = "5m", limit = 300): Promise<CandleResponseDto> {
    const query = new URLSearchParams({ contract, interval, limit: String(limit) });
    return this.#client.get(`/market/candles?${query.toString()}`);
  }

  health(): Promise<MarketHealthResponseDto> {
    return this.#client.get("/market/health");
  }
}
