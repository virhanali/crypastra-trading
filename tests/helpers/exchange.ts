import { Decimal, deriveAccount, OrderIntentSchema, type BookSnapshot, type OrderIntent } from "../../packages/core/src/index.js";
import type { DatabaseConnection } from "../../apps/server/src/db/database.js";
import { AccountRepository } from "../../apps/server/src/repositories/account-repository.js";
import { ContractRepository } from "../../apps/server/src/repositories/contract-repository.js";
import { FillRepository } from "../../apps/server/src/repositories/fill-repository.js";
import { LedgerRepository } from "../../apps/server/src/repositories/ledger-repository.js";
import { OrderRepository } from "../../apps/server/src/repositories/order-repository.js";
import { PositionRepository } from "../../apps/server/src/repositories/position-repository.js";
import { OrderService } from "../../apps/server/src/services/order-service.js";
import type { ContractSpec } from "../../packages/core/src/index.js";
import { openTempDatabase, type TempDatabase } from "./db.js";

export function deterministicIds(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}${String(counter).padStart(6, "0")}`;
  };
}

export interface ExchangeHarness {
  readonly connection: DatabaseConnection;
  readonly accounts: AccountRepository;
  readonly ledger: LedgerRepository;
  readonly orders: OrderRepository;
  readonly fills: FillRepository;
  readonly positions: PositionRepository;
  readonly contracts: ContractRepository;
  readonly service: OrderService;
  readonly accountId: string;
  /** Waktu deterministik (epoch ms). Tidak ada Date.now(). */
  now(): number;
  advance(ms?: number): number;
  available(): Decimal;
  balances(): ReturnType<LedgerRepository["balances"]>;
  cleanup(): void;
}

export interface SetupOptions {
  readonly initialBalance?: string;
  readonly specs?: readonly ContractSpec[];
  readonly deposit?: string;
  readonly startMs?: number;
  readonly withService?: boolean;
}

export function setupExchange(options: SetupOptions = {}): ExchangeHarness {
  const db: TempDatabase = openTempDatabase();
  const connection = db.connection;
  const accounts = new AccountRepository(connection);
  const ledger = new LedgerRepository(connection);
  const orders = new OrderRepository(connection);
  const fills = new FillRepository(connection);
  const positions = new PositionRepository(connection);
  const contracts = new ContractRepository(connection);

  const startMs = options.startMs ?? 1_700_000_000_000;
  let clock = startMs;

  const account = accounts.create({
    name: "paper",
    mode: "simulation",
    initialBalance: options.initialBalance ?? "10000",
    createdAtMs: startMs,
  });

  for (const spec of options.specs ?? []) {
    contracts.upsert({ spec, rawJson: "{}", updatedAtMs: startMs });
  }

  if (options.deposit !== undefined) {
    ledger.append({
      accountId: account.id,
      tsMs: startMs,
      type: "deposit",
      amount: options.deposit,
      idempotencyKey: `deposit:${account.id}`,
    });
  }

  const service = new OrderService({
    connection,
    orderIdFactory: deterministicIds("ord"),
    fillIdFactory: deterministicIds("fil"),
    positionIdFactory: deterministicIds("pos"),
  });

  return {
    connection,
    accounts,
    ledger,
    orders,
    fills,
    positions,
    contracts,
    service,
    accountId: account.id,
    now: () => clock,
    advance: (ms = 1) => {
      clock += ms;
      return clock;
    },
    available() {
      const balances = ledger.balances(account.id);
      return deriveAccount(
        {
          walletBalance: balances.walletBalance,
          usedMargin: balances.usedMargin,
          reservedMargin: balances.reservedMargin,
        },
        new Decimal(0),
      ).availableBalance;
    },
    balances: () => ledger.balances(account.id),
    cleanup() {
      db.cleanup();
    },
  };
}

export function book(
  contract: string,
  bids: ReadonlyArray<readonly [string, number]>,
  asks: ReadonlyArray<readonly [string, number]>,
  updateId = 1,
): BookSnapshot {
  return {
    contract,
    updateId,
    eventTsMs: 0,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

export interface IntentOverrides {
  readonly contract?: string;
  readonly side?: "buy" | "sell";
  readonly type?: "market" | "limit";
  readonly size?: number;
  readonly price?: string | null;
  readonly leverage?: string;
  readonly timeInForce?: "gtc" | "ioc" | "fok" | "post_only";
  readonly reduceOnly?: boolean;
  readonly tpPrice?: string | null;
  readonly slPrice?: string | null;
}

export function intent(overrides: IntentOverrides = {}): OrderIntent {
  return OrderIntentSchema.parse({
    contract: overrides.contract ?? "BTC_USDT",
    side: overrides.side ?? "buy",
    type: overrides.type ?? "market",
    size: overrides.size ?? 1,
    price: overrides.price ?? null,
    leverage: overrides.leverage ?? "10",
    timeInForce: overrides.timeInForce ?? "ioc",
    reduceOnly: overrides.reduceOnly ?? false,
    tpPrice: overrides.tpPrice ?? null,
    slPrice: overrides.slPrice ?? null,
  });
}

/** Buku BTC_USDT standar: ask 80000/80010/80020 dan bid 79990/79980/79970. */
export function btcBook(contract = "BTC_USDT"): BookSnapshot {
  return book(
    contract,
    [
      ["79990", 500],
      ["79980", 500],
      ["79970", 500],
    ],
    [
      ["80000", 500],
      ["80010", 500],
      ["80020", 500],
    ],
  );
}
