import type { ScannerResult } from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { scannerResults } from "../db/schema.js";

export interface ScannerResultRecord {
  readonly id: string;
  readonly contract: string;
  readonly interval: string;
  readonly t: number;
  readonly result: ScannerResult;
}

/**
 * ScannerResultRepository — keluaran riset, BUKAN peristiwa ekonomi.
 *
 * Tidak masuk `domain_events` karena tidak mengubah ledger/posisi; tidak masuk
 * `decisions` karena `decisions` adalah tempat keputusan ekonomi (ukuran,
 * leverage, SL/TP) yang belum ada di Phase 9. Idempoten per
 * (contract, interval, t, feature_version, scanner_version, config_hash).
 */
export class ScannerResultRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  insertIfAbsent(result: ScannerResult, createdAtMs: number): boolean {
    const id = [
      "sr",
      result.contract,
      result.timeframe,
      String(result.candleCloseTimeMs),
      result.featureVersion,
      result.scannerVersion,
      result.scannerConfigHash,
    ].join(":");
    const inserted = this.#conn.db
      .insert(scannerResults)
      .values({
        id,
        contract: result.contract,
        interval: result.timeframe,
        t: result.candleCloseTimeMs,
        featureVersion: result.featureVersion,
        scannerVersion: result.scannerVersion,
        scannerConfigHash: result.scannerConfigHash,
        status: result.status,
        direction: result.direction,
        setupType: result.setupType,
        signal: result.signal,
        factsJson: JSON.stringify(result.facts),
        reasonCodesJson: JSON.stringify(result.reasonCodes),
        createdAt: createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: scannerResults.id })
      .all();
    return inserted.length > 0;
  }

  list(filter: { contract?: string; interval?: string; limit?: number } = {}): ScannerResultRecord[] {
    const where = [
      ...(filter.contract === undefined ? [] : [eq(scannerResults.contract, filter.contract)]),
      ...(filter.interval === undefined ? [] : [eq(scannerResults.interval, filter.interval)]),
    ];
    return this.#conn.db
      .select()
      .from(scannerResults)
      .where(where.length === 0 ? undefined : and(...where))
      .orderBy(asc(scannerResults.t), asc(scannerResults.contract))
      .limit(filter.limit ?? 100_000)
      .all()
      .map((row) => ({
        id: row.id,
        contract: row.contract,
        interval: row.interval,
        t: row.t,
        result: {
          contract: row.contract,
          timeframe: row.interval,
          candleCloseTimeMs: row.t,
          featureVersion: row.featureVersion,
          scannerVersion: row.scannerVersion,
          scannerConfigHash: row.scannerConfigHash,
          status: row.status as ScannerResult["status"],
          direction: row.direction as ScannerResult["direction"],
          setupType: row.setupType as ScannerResult["setupType"],
          signal: row.signal as ScannerResult["signal"],
          facts: JSON.parse(row.factsJson) as ScannerResult["facts"],
          reasonCodes: JSON.parse(row.reasonCodesJson) as ScannerResult["reasonCodes"],
        },
      }));
  }

  count(): number {
    const row = this.#conn.db
      .select({ n: sql<number>`count(*)` })
      .from(scannerResults)
      .get();
    return row?.n ?? 0;
  }
}
