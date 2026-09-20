import { ApiClient, type ApiClientConfig } from "./client.js";
import { AccountsApi } from "./accounts.js";
import { ContractsApi } from "./contracts.js";
import { HistoryApi } from "./history.js";
import { MarketApi } from "./market.js";
import { OrdersApi } from "./orders.js";
import { PositionsApi } from "./positions.js";

/** Satu titik masuk untuk seluruh akses data. Komponen tidak memanggil fetch. */
export class TerminalApi {
  readonly client: ApiClient;
  readonly accounts: AccountsApi;
  readonly contracts: ContractsApi;
  readonly positions: PositionsApi;
  readonly orders: OrdersApi;
  readonly history: HistoryApi;
  readonly market: MarketApi;

  constructor(config: ApiClientConfig = {}) {
    this.client = new ApiClient(config);
    this.accounts = new AccountsApi(this.client);
    this.contracts = new ContractsApi(this.client);
    this.positions = new PositionsApi(this.client);
    this.orders = new OrdersApi(this.client);
    this.history = new HistoryApi(this.client);
    this.market = new MarketApi(this.client);
  }
}

export * from "./client.js";
export * from "./types.js";
export { AccountsApi, ContractsApi, HistoryApi, MarketApi, OrdersApi, PositionsApi };
