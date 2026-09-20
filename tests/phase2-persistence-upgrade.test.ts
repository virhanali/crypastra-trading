import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractSpecSchema } from "../packages/core/src/index.js";
import { openDatabase, type DatabaseConnection } from "../apps/server/src/db/database.js";
import { ContractRepository } from "../apps/server/src/repositories/contract-repository.js";
import { ETH_USDT, BTC_USDT } from "./helpers/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const MIGRATIONS_DIR = join(import.meta.dir, "..", "apps", "server", "drizzle");

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crypastra-upgrade-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Siapkan folder migrasi yang hanya berisi migrasi sampai `0001`, untuk
 * mensimulasikan database Phase 1 yang sudah terisi sebelum `enable_decimal`.
 */
function migrationsUpToPhase1(dir: string): string {
  const target = join(dir, "migrations");
  cpSync(MIGRATIONS_DIR, target, { recursive: true });
  // Pertahankan hanya migrasi 0000 dan 0001 (skema Phase 1). SEMUA migrasi
  // setelahnya harus dibuang: migrator Drizzle menerapkan migrasi yang
  // `when`-nya lebih besar dari yang terakhir diterapkan, jadi menyisakan
  // 0003 akan membuat 0002 terlewat pada upgrade berikutnya.
  const keep = (tag: string): boolean => tag.startsWith("0000") || tag.startsWith("0001");
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const removed = journal.entries.filter((entry) => !keep(entry.tag));
  for (const entry of removed) {
    rmSync(join(target, `${entry.tag}.sql`), { force: true });
  }
  journal.entries = journal.entries.filter((entry) => keep(entry.tag));
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return target;
}

describe("upgrade database Phase 1 → Phase 2 (enable_decimal)", () => {
  test("migrasi 0002 berjalan pada DB Phase 1 yang sudah berisi baris contracts", () => {
    const dir = tempDir();
    const dbPath = join(dir, "phase1.db");
    const phase1Migrations = migrationsUpToPhase1(dir);

    // 1. Bangun DB pada skema Phase 1.
    process.env.CRYPASTRA_MIGRATIONS_DIR = phase1Migrations;
    let connection: DatabaseConnection;
    try {
      connection = openDatabase({ path: dbPath });
    } finally {
      delete process.env.CRYPASTRA_MIGRATIONS_DIR;
    }

    // Kolom belum ada.
    const beforeColumns = connection.sqlite
      .query("PRAGMA table_info(contracts)")
      .all() as Array<{ name: string }>;
    expect(beforeColumns.map((column) => column.name)).not.toContain("enable_decimal");

    // 2. Isi data seperti kondisi produksi Phase 1 (tanpa kolom enable_decimal,
    //    karena repository saat itu belum mengenalnya). Pakai SQL mentah.
    connection.sqlite
      .prepare(
        `INSERT INTO contracts (
           id, base, quote, quanto_multiplier, order_size_min, order_size_max,
           order_price_round, mark_price_round, leverage_min, leverage_max,
           maintenance_rate, maker_fee_rate, taker_fee_rate, funding_interval_seconds,
           market_order_slip_ratio, status, source, raw_json, updated_at
         ) VALUES ('BTC_USDT','BTC','USDT','0.0001',1,12000000,'0.1','0.01','1','200',
                   '0.003','-0.0001','0.00075',28800,'0.01','trading','gateio','{}',1)`,
      )
      .run();
    const seeded = connection.sqlite
      .query("SELECT COUNT(*) AS n FROM contracts")
      .get() as { n: number };
    expect(seeded.n).toBe(1);
    connection.close();

    // 3. Jalankan migrasi penuh (termasuk 0002) pada DB yang sudah terisi.
    const upgraded = openDatabase({ path: dbPath });
    cleanups.push(() => {
      try {
        upgraded.close();
      } catch {
        /* sudah tertutup */
      }
    });

    const afterColumns = upgraded.sqlite
      .query("PRAGMA table_info(contracts)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const enableColumn = afterColumns.find((column) => column.name === "enable_decimal");
    expect(enableColumn).toBeDefined();
    // SQLite menormalkan tipe hasil ALTER TABLE menjadi huruf besar; afinitasnya
    // tetap integer dan tidak ada bedanya secara fungsional.
    expect(enableColumn!.type.toLowerCase()).toBe("integer");
    expect(enableColumn!.notnull).toBe(1);

    // Baris lama tetap ada dan mendapat default 0 (false).
    expect(repo2(upgraded).count()).toBe(1);
    const existing = repo2(upgraded).require("BTC_USDT");
    expect(existing.enableDecimal).toBe(false);

    // Data lama tidak berubah.
    expect(existing.quantoMultiplier).toBe(BTC_USDT.quantoMultiplier);
    expect(existing.orderPriceRound).toBe(BTC_USDT.orderPriceRound);
  });

  test("setelah upgrade, kontrak desimal (ETH) round-trip dengan enableDecimal true", () => {
    const dir = tempDir();
    const dbPath = join(dir, "roundtrip.db");

    const connection = openDatabase({ path: dbPath });
    cleanups.push(() => {
      try {
        connection.close();
      } catch {
        /* sudah tertutup */
      }
    });
    const repo = new ContractRepository(connection);

    repo.upsert({ spec: ETH_USDT, rawJson: "{}", updatedAtMs: 1 });
    const loaded = repo.require("ETH_USDT");

    expect(loaded.enableDecimal).toBe(true);
    expect(loaded.orderSizeMin).toBe(0);
    expect(loaded.quantoMultiplier).toBe("0.01");
    // Round-trip penuh lewat skema zod tetap sah.
    expect(() => ContractSpecSchema.parse(loaded)).not.toThrow();
    expect(loaded).toEqual(ETH_USDT);
  });

  test("enableDecimal default false untuk kontrak lama yang tidak menyertakannya", () => {
    const parsed = ContractSpecSchema.parse({
      contract: "OLD_USDT",
      base: "OLD",
      quote: "USDT",
      quantoMultiplier: "0.0001",
      orderSizeMin: 1,
      orderSizeMax: 100,
      orderPriceRound: "0.1",
      markPriceRound: "0.01",
      leverageMin: "1",
      leverageMax: "100",
      maintenanceRate: "0.003",
      makerFeeRate: "-0.0001",
      takerFeeRate: "0.00075",
      fundingIntervalSeconds: 28800,
      status: "trading",
      source: "gateio",
    });
    expect(parsed.enableDecimal).toBe(false);
  });
});

function repo2(connection: DatabaseConnection): ContractRepository {
  return new ContractRepository(connection);
}
