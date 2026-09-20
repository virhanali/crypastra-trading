import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal, ContractSpecSchema } from "../packages/core/src/index.js";
import { openDatabase, type DatabaseConnection } from "../apps/server/src/db/database.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { CandleRepository } from "../apps/server/src/repositories/candle-repository.js";
import { marketDedupeKey, MarketEventRepository } from "../apps/server/src/repositories/market-event-repository.js";
import { AccountRepository } from "../apps/server/src/repositories/account-repository.js";
import { LedgerRepository } from "../apps/server/src/repositories/ledger-repository.js";
import { openTempDatabase, type TempDatabase } from "./helpers/db.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function fresh(): TempDatabase {
  const db = openTempDatabase();
  cleanups.push(db.cleanup);
  return db;
}

function tableNames(connection: DatabaseConnection): string[] {
  const rows = connection.sqlite
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

const EXPECTED_TABLES = [
  "account_balances",
  "account_config",
  "accounts",
  "candles",
  "contracts",
  "candidate_outcome_labels",
  "decisions",
  "decision_executions",
  "domain_events",
  "feature_snapshots",
  "fills",
  "jev_evaluations",
  "ledger",
  "market_events",
  "market_observations",
  "market_recording_sessions",
  "order_events",
  "orders",
  "position_events",
  "positions",
  "scanner_results",
  "trade_commands",
  "trade_records",
  "treatment_results",
].sort();

describe("1 & 2. migrasi", () => {
  test("database kosong bermigrasi ke skema lengkap", () => {
    const { connection } = fresh();
    const tables = tableNames(connection).filter((name) => !name.startsWith("__drizzle"));
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  test("menjalankan migrasi lagi aman (idempoten, tidak menggandakan)", () => {
    const dir = mkdtempSync(join(tmpdir(), "crypastra-migrate-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "idempotent.db");

    const first = openDatabase({ path });
    const firstTables = tableNames(first);
    const firstApplied = migrationsCount(first);
    first.close();

    const second = openDatabase({ path });
    const secondTables = tableNames(second);
    const secondApplied = migrationsCount(second);

    expect(secondTables).toEqual(firstTables);
    // Migrasi yang sudah diterapkan tidak diulang.
    expect(secondApplied).toBe(firstApplied);

    // Dan DB masih berfungsi setelah migrasi kedua.
    const accounts = new AccountRepository(second);
    expect(accounts.count()).toBe(0);
    second.close();
  });

  test("trigger append-only terpasang oleh migrasi", () => {
    const { connection } = fresh();
    const rows = connection.sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      "domain_events_no_delete",
      "domain_events_no_update",
      "ledger_no_delete",
      "ledger_no_update",
      "market_events_no_delete",
      "market_events_no_update",
      "market_observations_no_delete",
      "market_observations_no_update",
    ]);
  });
});

describe("3. tidak ada kolom REAL/NUMERIC", () => {
  test("semua kolom tabel memakai TEXT/INTEGER, tidak ada floating point", () => {
    const { connection } = fresh();
    const offenders: string[] = [];
    for (const table of tableNames(connection)) {
      if (table.startsWith("__drizzle")) {
        continue;
      }
      const columns = connection.sqlite.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{
        name: string;
        type: string;
      }>;
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(column.type)) {
          offenders.push(`${table}.${column.name} bertipe ${column.type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("4. round-trip desimal eksak", () => {
  const DIFFICULT_VALUES = [
    "0.00000001",
    "80445.79000000",
    "123456789.12345678",
    "-0.0001",
  ];

  test("nilai sulit tersimpan dan terbaca kembali tanpa kehilangan presisi", () => {
    const { connection } = fresh();
    const accounts = new AccountRepository(connection);
    const ledger = new LedgerRepository(connection);
    const account = accounts.create({
      name: "round-trip",
      mode: "simulation",
      initialBalance: "0",
      createdAtMs: 1,
    });

    DIFFICULT_VALUES.forEach((value, index) => {
      ledger.append({
        accountId: account.id,
        tsMs: index + 1,
        type: "adjustment",
        amount: value,
        idempotencyKey: `rt-${index}`,
      });
    });

    const entries = ledger.list(account.id);
    expect(entries).toHaveLength(DIFFICULT_VALUES.length);

    DIFFICULT_VALUES.forEach((value, index) => {
      const entry = entries[index]!;
      // Nilai desimal sama persis.
      expect(entry.amount.eq(new Decimal(value))).toBe(true);
      // Dan tersimpan sebagai string 8 dp kanonik.
      const raw = connection.sqlite
        .query("SELECT amount FROM ledger WHERE idempotency_key = ?")
        .get(`rt-${index}`) as { amount: string };
      expect(raw.amount).toMatch(/^-?\d+\.\d{8}$/);
      expect(new Decimal(raw.amount).eq(new Decimal(value))).toBe(true);
    });

    // Saldo = jumlah aljabar nilai sulit.
    const expected = DIFFICULT_VALUES.reduce((sum, value) => sum.plus(value), new Decimal(0));
    expect(ledger.balances(account.id).walletBalance.eq(expected)).toBe(true);
  });

  test("nilai 20 dp dibulatkan ke skala uang 8 dp yang disepakati", () => {
    const { connection } = fresh();
    const accounts = new AccountRepository(connection);
    const ledger = new LedgerRepository(connection);
    const account = accounts.create({
      name: "20dp",
      mode: "simulation",
      initialBalance: "0",
      createdAtMs: 1,
    });

    ledger.append({
      accountId: account.id,
      tsMs: 1,
      type: "adjustment",
      amount: "0.12345678901234567890",
      idempotencyKey: "twenty-dp",
    });

    const raw = connection.sqlite
      .query("SELECT amount FROM ledger WHERE idempotency_key = 'twenty-dp'")
      .get() as { amount: string };
    expect(raw.amount).toBe("0.12345679");
  });
});

describe("14. urutan kronologis market_events", () => {
  test("list() mengembalikan urutan deterministik berdasarkan seq", () => {
    const { connection } = fresh();
    const repo = new MarketEventRepository(connection);

    // Sengaja tidak berurutan berdasarkan event_ts, untuk membuktikan urutan
    // mengikuti urutan ingest (seq), bukan timestamp mentah.
    const timestamps = [300, 100, 200, 500, 400];
    timestamps.forEach((ts, index) => {
      repo.append({
        provider: "gateio",
        channel: "futures.trades",
        contract: "BTC_USDT",
        eventTsMs: ts,
        dedupeKey: marketDedupeKey("gateio", "futures.trades", "BTC_USDT", `trade-${index}`),
        payload: { index, ts },
        ingestedAtMs: ts,
      });
    });

    const events = repo.list("BTC_USDT");
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.eventTsMs)).toEqual(timestamps);

    const seqs = events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // afterSeq memberi kelanjutan replay tanpa duplikasi.
    const resumed = repo.list("BTC_USDT", { afterSeq: seqs[2]! });
    expect(resumed.map((event) => event.eventTsMs)).toEqual([500, 400]);
  });

  test("dedupe_key yang sama tidak menggandakan event", () => {
    const { connection } = fresh();
    const repo = new MarketEventRepository(connection);
    const key = marketDedupeKey("gateio", "futures.candlesticks", "BTC_USDT", "1789901100");

    const first = repo.append({
      provider: "gateio",
      channel: "futures.candlesticks",
      contract: "BTC_USDT",
      eventTsMs: 1789901100000,
      dedupeKey: key,
      payload: { o: "1" },
      ingestedAtMs: 1,
    });
    const second = repo.append({
      provider: "gateio",
      channel: "futures.candlesticks",
      contract: "BTC_USDT",
      eventTsMs: 1789901100000,
      dedupeKey: key,
      payload: { o: "2" },
      ingestedAtMs: 2,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(repo.count()).toBe(1);
  });
});

describe("15. spesifikasi kontrak heterogen", () => {
  test("quanto_multiplier & order_price_round ekstrem dipertahankan eksak", () => {
    const { connection } = fresh();
    const repo = new ContractRepository(connection);

    const specs = [
      // BTC: multiplier kecil, tick 0.1
      { contract: "BTC_USDT", base: "BTC", quote: "USDT", quantoMultiplier: "0.0001", orderPriceRound: "0.1", markPriceRound: "0.01" },
      // Altcoin dengan multiplier 1 (JANGAN asumsikan 0.0001)
      { contract: "XYZ_USDT", base: "XYZ", quote: "USDT", quantoMultiplier: "1", orderPriceRound: "0.0001", markPriceRound: "0.00001" },
      // Multiplier besar
      { contract: "BIG_USDT", base: "BIG", quote: "USDT", quantoMultiplier: "10000000", orderPriceRound: "0.01", markPriceRound: "0.001" },
      // Tick 11 dp seperti SATS_USDT di Gate.io
      { contract: "SATS_USDT", base: "SATS", quote: "USDT", quantoMultiplier: "0.000000001", orderPriceRound: "0.00000000001", markPriceRound: "0.00000000001" },
    ];

    for (const partial of specs) {
      repo.upsert({
        spec: ContractSpecSchema.parse({
          ...partial,
          orderSizeMin: 1,
          orderSizeMax: 12000000,
          leverageMin: "1",
          leverageMax: "200",
          maintenanceRate: "0.003",
          makerFeeRate: "-0.0001",
          takerFeeRate: "0.00075",
          fundingIntervalSeconds: 28800,
          marketOrderSlipRatio: "0.01",
          status: "trading",
          source: "gateio",
        }),
        rawJson: "{}",
        updatedAtMs: 1,
      });
    }

    for (const partial of specs) {
      const loaded = repo.require(partial.contract);
      expect(new Decimal(loaded.quantoMultiplier).eq(new Decimal(partial.quantoMultiplier))).toBe(true);
      expect(new Decimal(loaded.orderPriceRound).eq(new Decimal(partial.orderPriceRound))).toBe(true);
      expect(new Decimal(loaded.markPriceRound).eq(new Decimal(partial.markPriceRound))).toBe(true);
    }

    // Tick 11 dp tidak dibulatkan menjadi 0.
    expect(connection.sqlite
      .query("SELECT order_price_round AS v FROM contracts WHERE id = 'SATS_USDT'")
      .get() as { v: string }).toEqual({ v: "0.00000000001" });

    // Upsert pada kontrak yang sama tidak menggandakan baris.
    repo.upsert({
      spec: repo.require("BTC_USDT"),
      rawJson: "{}",
      updatedAtMs: 2,
    });
    expect(repo.count()).toBe(specs.length);
    expect(repo.listActive()).toHaveLength(specs.length);
  });
});

describe("candles", () => {
  test("upsert idempoten pada kunci (contract, interval, t) dan query rentang", () => {
    const { connection } = fresh();
    const repo = new CandleRepository(connection);
    const base = {
      contract: "BTC_USDT",
      interval: "5m",
      o: "80000",
      h: "80100",
      l: "79900",
      c: "80050",
      v: 10,
      sum: "800500",
      windowClosed: false,
    };

    repo.upsert({ candle: { ...base, openTimeSeconds: 300 }, provider: "gateio", ingestedAtMs: 1 });
    repo.upsert({ candle: { ...base, openTimeSeconds: 600 }, provider: "gateio", ingestedAtMs: 2 });
    // Menimpa candle yang sama dengan versi final.
    repo.upsert({
      candle: { ...base, openTimeSeconds: 600, c: "80123", windowClosed: true },
      provider: "gateio",
      ingestedAtMs: 3,
    });

    expect(repo.count()).toBe(2);
    const range = repo.queryRange("BTC_USDT", "5m", 300, 600);
    expect(range).toHaveLength(2);
    expect(range[1]!.c).toBe("80123");
    expect(range[1]!.windowClosed).toBe(true);
    expect(repo.latest("BTC_USDT", "5m")?.openTimeSeconds).toBe(600);
  });
});

function migrationsCount(connection: DatabaseConnection): number {
  const rows = connection.sqlite
    .query("SELECT COUNT(*) AS n FROM __drizzle_migrations")
    .get() as { n: number };
  return rows.n;
}
