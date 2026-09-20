import type { CandidateOutcomeLabel, HorizonLabel } from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { candidateOutcomeLabels } from "../db/schema.js";

/**
 * CandidateOutcomeLabelRepository — label hasil OFFLINE (Phase 13).
 *
 * Jalur riset saja. TIDAK boleh dipanggil dari perlakuan/keputusan/eksekusi
 * hidup; guard impor menegakkan itu.
 */
export class CandidateOutcomeLabelRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  insertIfAbsent(label: CandidateOutcomeLabel, createdAtMs: number): boolean {
    const inserted = this.#conn.db
      .insert(candidateOutcomeLabels)
      .values({
        id: `label:${label.inputHash}:${label.labelVersion}`,
        inputHash: label.inputHash,
        contract: label.contract,
        interval: label.timeframe,
        t: label.candleCloseTimeMs,
        direction: label.direction,
        labelVersion: label.labelVersion,
        priceSource: label.priceSource,
        referenceClose: label.referenceClose,
        atr14: label.atr14,
        horizonsJson: JSON.stringify(label.horizons),
        labelsJson: JSON.stringify(label.horizonLabels),
        status: label.status,
        incompleteReason: label.incompleteReason,
        createdAt: createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: candidateOutcomeLabels.id })
      .all();
    return inserted.length > 0;
  }

  find(inputHash: string, labelVersion: string): CandidateOutcomeLabel | null {
    const row = this.#conn.db
      .select()
      .from(candidateOutcomeLabels)
      .where(
        and(
          eq(candidateOutcomeLabels.inputHash, inputHash),
          eq(candidateOutcomeLabels.labelVersion, labelVersion),
        ),
      )
      .get();
    return row === undefined ? null : mapRow(row);
  }

  list(filter: { contract?: string; limit?: number } = {}): CandidateOutcomeLabel[] {
    const where = filter.contract === undefined ? undefined : eq(candidateOutcomeLabels.contract, filter.contract);
    return this.#conn.db
      .select()
      .from(candidateOutcomeLabels)
      .where(where)
      .orderBy(asc(candidateOutcomeLabels.t), asc(candidateOutcomeLabels.contract))
      .limit(filter.limit ?? 100_000)
      .all()
      .map(mapRow);
  }

  count(): number {
    const row = this.#conn.db.select({ n: sql<number>`count(*)` }).from(candidateOutcomeLabels).get();
    return row?.n ?? 0;
  }
}

function mapRow(row: typeof candidateOutcomeLabels.$inferSelect): CandidateOutcomeLabel {
  return {
    inputHash: row.inputHash,
    contract: row.contract,
    timeframe: row.interval,
    candleCloseTimeMs: row.t,
    direction: row.direction as CandidateOutcomeLabel["direction"],
    labelVersion: row.labelVersion,
    horizons: JSON.parse(row.horizonsJson) as number[],
    priceSource: row.priceSource as CandidateOutcomeLabel["priceSource"],
    referenceClose: row.referenceClose,
    atr14: row.atr14,
    horizonLabels: JSON.parse(row.labelsJson) as HorizonLabel[],
    status: row.status as CandidateOutcomeLabel["status"],
    incompleteReason: row.incompleteReason,
  };
}
