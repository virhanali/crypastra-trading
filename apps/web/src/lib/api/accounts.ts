import type { ApiClient } from "./client.js";
import type { AccountDto, AccountSummaryDto } from "./types.js";

/** Endpoint akun + perintah yang mengubah keadaan (selalu dengan commandId). */
export class AccountsApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  list(): Promise<{ accounts: AccountDto[] }> {
    return this.#client.get("/accounts");
  }

  create(input: {
    commandId: string;
    name: string;
    initialBalance: string;
    mode?: "simulation" | "live" | "replay";
  }): Promise<{ account: AccountDto; duplicate: boolean }> {
    return this.#client.post("/accounts", {
      commandId: input.commandId,
      name: input.name,
      mode: input.mode ?? "simulation",
      baseCurrency: "USDT",
      initialBalance: input.initialBalance,
    });
  }

  get(accountId: string): Promise<{ account: AccountDto }> {
    return this.#client.get(`/accounts/${encodeURIComponent(accountId)}`);
  }

  summary(accountId: string): Promise<AccountSummaryDto> {
    return this.#client.get(`/accounts/${encodeURIComponent(accountId)}/summary`);
  }

  deposit(accountId: string, input: { commandId: string; amount: string }): Promise<unknown> {
    return this.#client.post(`/accounts/${encodeURIComponent(accountId)}/deposit`, {
      commandId: input.commandId,
      amount: input.amount,
    });
  }

  withdraw(accountId: string, input: { commandId: string; amount: string }): Promise<unknown> {
    return this.#client.post(`/accounts/${encodeURIComponent(accountId)}/withdraw`, {
      commandId: input.commandId,
      amount: input.amount,
    });
  }

  reset(accountId: string, input: { commandId: string; balance: string }): Promise<unknown> {
    return this.#client.post(`/accounts/${encodeURIComponent(accountId)}/reset`, {
      commandId: input.commandId,
      balance: input.balance,
    });
  }
}
