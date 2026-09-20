import type { FeatureSnapshot } from "@crypastra/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { featureSnapshots } from "../db/schema.js";

export interface FeatureSnapshotRecord {
  readonly id: string;
  readonly contract: string;
  readonly interval: string;
  readonly t: number;
  readonly features: FeatureSnapshot;
  readonly engineVersion: string;
  readonly createdAt: number;
}

/**
 * FeatureSnapshotRepository — data riset/analitik (Phase 9).
 *
 * Idempoten per (contract, interval, t, engine_version) lewat unique index;
 * pengiriman ulang candle yang sama tidak boleh menghasilkan baris kedua.
 * Id diturunkan DETERMINISTIK dari kuncinya (bukan UUID/waktu) supaya replay
 * ulang menghasilkan baris identik.
 */
export class FeatureSnapshotRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  static idFor(input: {
    contract: string;
    interval: string;
    t: number;
    engineVersion: string;
  }): string {
    return `fs:${input.contract}:${input.interval}:${input.t}:${input.engineVersion}`;
  }

  /** Kembalikan true bila baris baru benar-benar disisipkan. */
  insertIfAbsent(snapshot: FeatureSnapshot, createdAtMs: number): boolean {
    const result = this.#conn.db
      .insert(featureSnapshots)
      .values({
        id: FeatureSnapshotRepository.idFor({
          contract: snapshot.contract,
          interval: snapshot.timeframe,
          t: snapshot.candleOpenTimeMs,
          engineVersion: snapshot.featureVersion,
        }),
        contract: snapshot.contract,
        interval: snapshot.timeframe,
        t: snapshot.candleOpenTimeMs,
        featuresJson: JSON.stringify(snapshot),
        engineVersion: snapshot.featureVersion,
        createdAt: createdAtMs,
      })
      .onConflictDoNothing()
      .returning({ id: featureSnapshots.id })
      .all();
    return result.length > 0;
  }

  list(filter: { contract?: string; interval?: string; limit?: number } = {}): FeatureSnapshotRecord[] {
    const where = [
      ...(filter.contract === undefined ? [] : [eq(featureSnapshots.contract, filter.contract)]),
      ...(filter.interval === undefined ? [] : [eq(featureSnapshots.interval, filter.interval)]),
    ];
    const query = this.#conn.db
      .select()
      .from(featureSnapshots)
      .where(where.length === 0 ? undefined : and(...where))
      .orderBy(asc(featureSnapshots.t), asc(featureSnapshots.contract))
      .limit(filter.limit ?? 100_000);
    return query.all().map((row) => ({
      id: row.id,
      contract: row.contract,
      interval: row.interval,
      t: row.t,
      features: JSON.parse(row.featuresJson) as FeatureSnapshot,
      engineVersion: row.engineVersion,
      createdAt: row.createdAt,
    }));
  }

  latest(contract: string, interval: string): FeatureSnapshotRecord | null {
    const row = this.#conn.db
      .select()
      .from(featureSnapshots)
      .where(and(eq(featureSnapshots.contract, contract), eq(featureSnapshots.interval, interval)))
      .orderBy(desc(featureSnapshots.t))
      .limit(1)
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      contract: row.contract,
      interval: row.interval,
      t: row.t,
      features: JSON.parse(row.featuresJson) as FeatureSnapshot,
      engineVersion: row.engineVersion,
      createdAt: row.createdAt,
    };
  }

  count(): number {
    const row = this.#conn.db
      .select({ n: sql<number>`count(*)` })
      .from(featureSnapshots)
      .get();
    return row?.n ?? 0;
  }
}
