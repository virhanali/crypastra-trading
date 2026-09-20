import type { ApiClient } from "./client.js";
import type { ContractDto } from "./types.js";

export class ContractsApi {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  list(): Promise<{ contracts: ContractDto[] }> {
    return this.#client.get("/contracts");
  }

  get(contract: string): Promise<ContractDto> {
    return this.#client.get(`/contracts/${encodeURIComponent(contract)}`);
  }
}
