import { Decimal } from "../../packages/core/src/index.js";
import { createApp, type AppContext } from "../../apps/server/src/api/app.js";
import { InMemoryMarketSnapshotProvider } from "../../apps/server/src/market/market-snapshot-provider.js";
import { createRealtimeHub, type RealtimeHub } from "../../apps/server/src/realtime/ws.js";
import type { DatabaseConnection } from "../../apps/server/src/db/database.js";
import { ContractRepository } from "../../apps/server/src/repositories/contract-repository.js";
import { BTC_USDT, ETH_USDT, SOL_USDT } from "./fixtures.js";
import { openTempDatabase, type TempDatabase } from "./db.js";

export interface HttpResult {
  readonly status: number;
  readonly json: any;
  readonly raw: string;
}

export interface ApiHarness {
  readonly connection: DatabaseConnection;
  readonly context: AppContext;
  readonly market: InMemoryMarketSnapshotProvider;
  readonly accountId: string;
  clock: { ms: number };
  request(method: string, url: string, payload?: unknown): Promise<HttpResult>;
  /** Jalankan server nyata (untuk test WebSocket). */
  listen(realtime?: boolean): Promise<{ url: string; hub: RealtimeHub | null; close(): Promise<void> }>;
  cleanup(): void;
}

export function setupApi(
  options: {
    initialBalance?: string;
    enableSimulation?: boolean;
    mode?: "simulation" | "live";
    feedHealth?: () => { state: string; ready: boolean; [key: string]: unknown };
    marketDetail?: (contract: string) => {
      contract: string;
      markPrice: string | null;
      markSourceTimestampMs: number | null;
      markStatus: "fresh" | "stale" | "missing";
      lastPrice: string | null;
      indexPrice: string | null;
      fundingRate: string | null;
      fundingNextApplyMs: number | null;
      bestBid: string | null;
      bestBidSize: number | null;
      bestAsk: string | null;
      bestAskSize: number | null;
      depthStatus: "syncing" | "synced" | "unsynced" | null;
    } | null;
  } = {},
): ApiHarness {
  const db: TempDatabase = openTempDatabase();
  const connection = db.connection;
  const market = new InMemoryMarketSnapshotProvider();
  const clock = { ms: 1_700_000_000_000 };

  const context = createApp({
    connection,
    market,
    now: () => clock.ms,
    enableSimulation: options.enableSimulation,
    mode: options.mode,
    feedHealth: options.feedHealth,
    marketDetail: options.marketDetail,
    logger: false,
  });

  const contracts = new ContractRepository(connection);
  for (const spec of [BTC_USDT, ETH_USDT, SOL_USDT]) {
    contracts.upsert({ spec, rawJson: "{}", updatedAtMs: clock.ms });
  }
  // Akun awal dibuat lewat API (bukan repository) supaya harness mencerminkan
  // jalur yang sama dengan klien.
  const accountId = "acc-000001";
  const harness: ApiHarness = {
    connection,
    context,
    market,
    accountId,
    clock,
    async request(method, url, payload) {
      const response = await context.app.inject({
        method: method as "GET",
        url,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      const raw = response.body;
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      return { status: response.statusCode, json, raw };
    },
    async listen(realtime = true, realtimeOptions = {}) {
      const hub = realtime
        ? createRealtimeHub({
            connection,
            pollIntervalMs: 20,
            maxBatch: 50,
            maxQueue: 5,
            ...realtimeOptions,
          })
        : null;
      hub?.attach(context.app.server);
      const address = await context.app.listen({ port: 0, host: "127.0.0.1" });
      return {
        url: address,
        hub,
        close: async () => {
          await hub?.close();
          await context.app.close();
        },
      };
    },
    cleanup() {
      try {
        db.cleanup();
      } catch {
        /* sudah tertutup */
      }
    },
  };

  return harness;
}

let accountCounter = 0;

/** Buat akun lewat API dan kembalikan id-nya. commandId unik per pemanggilan. */
export async function createAccountViaApi(
  harness: ApiHarness,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  accountCounter += 1;
  const response = await harness.request("POST", "/api/v1/accounts", {
    commandId: `create-${accountCounter}`,
    name: "paper",
    mode: "simulation",
    baseCurrency: "USDT",
    initialBalance: "10000",
    ...overrides,
  });
  if (response.status >= 400) {
    throw new Error(`Gagal membuat akun: ${response.raw}`);
  }
  return response.json.account.accountId as string;
}

/** Suntik mark + bid/ask untuk kontrak melalui endpoint simulasi. */
export async function injectMarket(
  harness: ApiHarness,
  contract: string,
  markPrice: string,
  spread = "0",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const mid = new Decimal(markPrice);
  const half = new Decimal(spread).div(2);
  const bid = spread === "0" ? markPrice : mid.minus(half).toFixed();
  const ask = spread === "0" ? markPrice : mid.plus(half).toFixed();
  const response = await harness.request("POST", "/api/v1/simulation/market", {
    contract,
    markPrice,
    bidPrice: bid,
    askPrice: ask,
    ...extra,
  });
  if (response.status >= 400) {
    throw new Error(`Gagal menyuntik pasar: ${response.raw}`);
  }
}

/** Kumpulkan semua nilai numerik (non-integer) dari JSON untuk uji serialisasi. */
export function collectNumericLeaves(value: unknown, path = "$"): Array<{ path: string; value: number }> {
  const found: Array<{ path: string; value: number }> = [];
  if (typeof value === "number") {
    found.push({ path, value });
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectNumericLeaves(item, `${path}[${index}]`)));
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(...collectNumericLeaves(child, `${path}.${key}`));
    }
  }
  return found;
}
