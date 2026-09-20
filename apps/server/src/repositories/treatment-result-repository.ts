import type { TreatmentResult } from "@crypastra/core";
import { asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { treatmentResults } from "../db/schema.js";

/** Hasil perlakuan tersimpan (audit A/B). Bukan tabel ekonomi. */
export class TreatmentResultRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  insertIfAbsent(result: TreatmentResult, createdAtMs: number): boolean {
    const id = `tr:${result.inputHash}:${result.treatmentVersion}:${result.treatmentConfigHash}`;
    const inserted = this.#conn.db
      .insert(treatmentResults)
      .values({
        id,
        inputHash: result.inputHash,
        contract: result.contract,
        interval: result.timeframe,
        t: result.candleCloseTimeMs,
        direction: result.direction,
        treatmentKind: result.kind,
        treatmentVersion: result.treatmentVersion,
        treatmentConfigHash: result.treatmentConfigHash,
        status: result.status,
        reasonsJson: JSON.stringify(result.reasons),
        evaluationsJson: JSON.stringify(result.evaluations),
        createdAt: createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: treatmentResults.id })
      .all();
    return inserted.length > 0;
  }

  list(filter: { contract?: string; limit?: number } = {}): TreatmentResult[] {
    const where = filter.contract === undefined ? undefined : eq(treatmentResults.contract, filter.contract);
    return this.#conn.db
      .select()
      .from(treatmentResults)
      .where(where)
      .orderBy(asc(treatmentResults.t), asc(treatmentResults.contract))
      .limit(filter.limit ?? 100_000)
      .all()
      .map((row) => ({
        kind: row.treatmentKind,
        treatmentVersion: row.treatmentVersion,
        treatmentConfigHash: row.treatmentConfigHash,
        status: row.status as TreatmentResult["status"],
        direction: row.direction as TreatmentResult["direction"],
        contract: row.contract,
        timeframe: row.interval,
        candleCloseTimeMs: row.t,
        inputHash: row.inputHash,
        evaluations: JSON.parse(row.evaluationsJson) as TreatmentResult["evaluations"],
        reasons: JSON.parse(row.reasonsJson) as string[],
      }));
  }

  count(): number {
    const row = this.#conn.db.select({ n: sql<number>`count(*)` }).from(treatmentResults).get();
    return row?.n ?? 0;
  }
}
