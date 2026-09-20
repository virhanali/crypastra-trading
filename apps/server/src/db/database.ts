import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type CrypastraDatabase = BunSQLiteDatabase<typeof schema>;

export interface DatabaseOptions {
  /** Path file DB, atau ":memory:" untuk test. */
  readonly path?: string;
  /** Batas tunggu lock SQLite. Default 5000 ms (production), test bisa lebih pendek. */
  readonly busyTimeoutMs?: number;
  /** Jalankan migrasi saat membuka. Default true. */
  readonly runMigrations?: boolean;
}

export interface DatabaseConnection {
  readonly db: CrypastraDatabase;
  readonly sqlite: Database;
  readonly path: string;
  /**
   * Jalankan fn di dalam transaksi SQLite IMMEDIATE.
   *
   * BEGIN IMMEDIATE mengambil write-lock sejak awal transaksi. Ini pengganti
   * yang benar untuk `SELECT ... FOR UPDATE` di SQLite: tidak ada celah antara
   * baca dan tulis, sehingga dua penulis tidak bisa saling menimpa (lost update).
   * SQLite tidak punya row lock; IMMEDIATE adalah primitif yang tersedia.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export const DEFAULT_DB_PATH = "data/crypastra.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const defaultMigrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrationsFolder(): string {
  return process.env.CRYPASTRA_MIGRATIONS_DIR ?? defaultMigrationsFolder;
}

export function openDatabase(options: DatabaseOptions = {}): DatabaseConnection {
  const path = options.path ?? process.env.CRYPASTRA_DB_PATH ?? DEFAULT_DB_PATH;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const runMigrations = options.runMigrations ?? true;

  const source = path === ":memory:" ? path : resolve(path);
  if (source !== ":memory:") {
    mkdirSync(dirname(source), { recursive: true });
  }

  const sqlite = new Database(source, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // FULL sinkronisasi tidak diperlukan untuk paper trading; NORMAL cukup aman
  // untuk WAL dan jauh lebih cepat saat ingest pasar.
  sqlite.run("PRAGMA synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });

  if (runMigrations) {
    migrate(db, { migrationsFolder: migrationsFolder() });
  }

  function transaction<T>(fn: () => T): T {
    const runner = sqlite.transaction(fn);
    // .immediate() => BEGIN IMMEDIATE, bukan BEGIN (deferred).
    return runner.immediate();
  }

  return {
    db,
    sqlite,
    path: source,
    transaction,
    close: () => sqlite.close(true),
  };
}
