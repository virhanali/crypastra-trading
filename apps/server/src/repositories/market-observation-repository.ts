import {
  observationDedupeKey,
  type MarketObservation,
  type ObservationKind,
} from "@crypastra/core";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { marketObservations, marketRecordingSessions } from "../db/schema.js";
import { newId } from "./ids.js";

export interface RecordingSessionRecord {
  readonly id: string;
  readonly source: string;
  readonly contracts: readonly string[];
  readonly status: "recording" | "completed" | "aborted";
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly metadata: Record<string, unknown>;
}

export interface ObservationRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly observation: MarketObservation;
}

export interface ObservationQuery {
  readonly contract?: string;
  readonly kind?: ObservationKind;
  readonly fromSourceTsMs?: number;
  readonly toSourceTsMs?: number;
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface RecordingStats {
  readonly sessionId: string;
  readonly total: number;
  readonly byKind: Record<string, number>;
  readonly byContract: Record<string, number>;
  readonly bytes: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly durationMs: number;
  readonly observationsPerSecond: number | null;
  readonly bytesPerSecond: number | null;
  readonly projectedBytes: {
    readonly oneHour: number;
    readonly eightHours: number;
    readonly twentyFourHours: number;
  };
}

/** Sesi perekaman: identitas eksplisit untuk replay (bukan tebakan rentang waktu). */
export class RecordingSessionRepository {
  readonly #conn: DatabaseConnection;
  readonly #newId: () => string;

  constructor(connection: DatabaseConnection, idFactory: () => string = newId) {
    this.#conn = connection;
    this.#newId = idFactory;
  }

  start(input: {
    source: string;
    contracts: readonly string[];
    startedAtMs: number;
    metadata?: Record<string, unknown>;
    id?: string;
  }): RecordingSessionRecord {
    if (input.contracts.length === 0) {
      throw new ValidationError("Sesi perekaman memerlukan minimal satu kontrak");
    }
    const id = input.id ?? this.#newId();
    this.#conn.db
      .insert(marketRecordingSessions)
      .values({
        id,
        source: input.source,
        contractsJson: JSON.stringify([...input.contracts].sort()),
        status: "recording",
        startedAt: input.startedAtMs,
        endedAt: null,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      })
      .run();
    return this.require(id);
  }

  stop(id: string, endedAtMs: number, status: "completed" | "aborted" = "completed"): RecordingSessionRecord {
    const current = this.require(id);
    if (current.status !== "recording") {
      // Idempoten: menghentikan sesi yang sudah berhenti tidak mengubah apa pun.
      return current;
    }
    this.#conn.db
      .update(marketRecordingSessions)
      .set({ status, endedAt: endedAtMs })
      .where(eq(marketRecordingSessions.id, id))
      .run();
    return this.require(id);
  }

  find(id: string): RecordingSessionRecord | null {
    const row = this.#conn.db
      .select()
      .from(marketRecordingSessions)
      .where(eq(marketRecordingSessions.id, id))
      .get();
    return row === undefined ? null : mapSessionRow(row);
  }

  require(id: string): RecordingSessionRecord {
    const found = this.find(id);
    if (found === null) {
      throw new NotFoundError(`Sesi perekaman tidak ditemukan: ${id}`);
    }
    return found;
  }

  /** Sesi aktif (paling banyak satu dipakai recorder pada satu waktu). */
  active(): RecordingSessionRecord | null {
    const row = this.#conn.db
      .select()
      .from(marketRecordingSessions)
      .where(eq(marketRecordingSessions.status, "recording"))
      .orderBy(sql`rowid desc`)
      .get();
    return row === undefined ? null : mapSessionRow(row);
  }

  list(limit = 50): RecordingSessionRecord[] {
    return this.#conn.db
      .select()
      .from(marketRecordingSessions)
      .orderBy(asc(marketRecordingSessions.startedAt))
      .limit(limit)
      .all()
      .map(mapSessionRow);
  }
}

/**
 * Observasi pasar append-only.
 *
 * Tidak ada `update`/`delete`: trigger database menolak keduanya. Retensi
 * (purge per sesi) belum diimplementasikan; lihat docs/REPLAY.md §Retensi.
 */
export class MarketObservationRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  /**
   * Tulis observasi. Idempoten berdasarkan `dedupeKey` (identitas sumber),
   * sehingga replay pesan Gate setelah reconnect tidak menggandakan baris.
   */
  append(input: {
    sessionId: string;
    observation: MarketObservation;
    createdAtMs: number;
  }): { record: ObservationRecord | null; duplicate: boolean } {
    const key = `${input.sessionId}:${observationDedupeKey(input.observation)}`;
    const existing = this.#conn.db
      .select({ seq: marketObservations.seq })
      .from(marketObservations)
      .where(eq(marketObservations.dedupeKey, key))
      .get();
    if (existing !== undefined) {
      return { record: null, duplicate: true };
    }

    const observation = input.observation;
    const payload = JSON.stringify(observation);
    const inserted = this.#conn.db
      .insert(marketObservations)
      .values({
        sessionId: input.sessionId,
        contract: observation.contract,
        kind: observation.kind,
        sourceTimestampMs: observation.sourceTimestampMs,
        observedAtMs: observation.observedAtMs,
        dedupeKey: key,
        dataJson: payload,
        createdAt: input.createdAtMs,
      })
      .returning()
      .get();

    return {
      record: { seq: inserted.seq, sessionId: inserted.sessionId, observation },
      duplicate: false,
    };
  }

  /** Urutan kanonik replay: `ORDER BY seq ASC` (BUKAN berdasarkan timestamp). */
  list(sessionId: string, query: ObservationQuery = {}): ObservationRecord[] {
    const conditions = [eq(marketObservations.sessionId, sessionId)];
    if (query.contract !== undefined) {
      conditions.push(eq(marketObservations.contract, query.contract));
    }
    if (query.kind !== undefined) {
      conditions.push(eq(marketObservations.kind, query.kind));
    }
    if (query.fromSourceTsMs !== undefined) {
      conditions.push(gte(marketObservations.sourceTimestampMs, query.fromSourceTsMs));
    }
    if (query.toSourceTsMs !== undefined) {
      conditions.push(lte(marketObservations.sourceTimestampMs, query.toSourceTsMs));
    }
    if (query.afterSeq !== undefined && query.afterSeq > 0) {
      conditions.push(sql`${marketObservations.seq} > ${query.afterSeq}`);
    }

    return this.#conn.db
      .select()
      .from(marketObservations)
      .where(and(...conditions))
      .orderBy(asc(marketObservations.seq))
      .limit(query.limit ?? 100_000)
      .all()
      .map((row) => ({
        seq: row.seq,
        sessionId: row.sessionId,
        observation: JSON.parse(row.dataJson) as MarketObservation,
      }));
  }

  count(sessionId: string): number {
    const row = this.#conn.db
      .select({ total: sql<number>`count(*)` })
      .from(marketObservations)
      .where(eq(marketObservations.sessionId, sessionId))
      .get();
    return row?.total ?? 0;
  }

  /** Statistik untuk estimasi penyimpanan (docs/REPLAY.md). */
  stats(sessionId: string): RecordingStats {
    const session = new RecordingSessionRepository(this.#conn).require(sessionId);
    const byKind: Record<string, number> = {};
    const byContract: Record<string, number> = {};
    let total = 0;
    let bytes = 0;

    const kindRows = this.#conn.db
      .select({ kind: marketObservations.kind, total: sql<number>`count(*)`, size: sql<number>`sum(length(${marketObservations.dataJson}))` })
      .from(marketObservations)
      .where(eq(marketObservations.sessionId, sessionId))
      .groupBy(marketObservations.kind)
      .all();
    for (const row of kindRows) {
      byKind[row.kind] = row.total;
      total += row.total;
      bytes += row.size ?? 0;
    }

    const contractRows = this.#conn.db
      .select({ contract: marketObservations.contract, total: sql<number>`count(*)` })
      .from(marketObservations)
      .where(eq(marketObservations.sessionId, sessionId))
      .groupBy(marketObservations.contract)
      .all();
    for (const row of contractRows) {
      byContract[row.contract] = row.total;
    }

    const endedAtMs = session.endedAtMs ?? this.#conn.db
      .select({ last: sql<number | null>`max(${marketObservations.observedAtMs})` })
      .from(marketObservations)
      .where(eq(marketObservations.sessionId, sessionId))
      .get()?.last ?? session.startedAtMs;

    const durationMs = Math.max(1, endedAtMs - session.startedAtMs);
    const seconds = durationMs / 1000;

    return {
      sessionId,
      total,
      byKind,
      byContract,
      bytes,
      startedAtMs: session.startedAtMs,
      endedAtMs,
      durationMs,
      observationsPerSecond: seconds > 0 ? total / seconds : null,
      bytesPerSecond: seconds > 0 ? bytes / seconds : null,
      projectedBytes: {
        oneHour: Math.round((bytes / seconds) * 3600),
        eightHours: Math.round((bytes / seconds) * 28_800),
        twentyFourHours: Math.round((bytes / seconds) * 86_400),
      },
    };
  }
}

function mapSessionRow(row: typeof marketRecordingSessions.$inferSelect): RecordingSessionRecord {
  const contracts: unknown = JSON.parse(row.contractsJson);
  const metadata: unknown = JSON.parse(row.metadataJson);
  return {
    id: row.id,
    source: row.source,
    contracts: Array.isArray(contracts) ? contracts.map(String) : [],
    status: row.status as RecordingSessionRecord["status"],
    startedAtMs: row.startedAt,
    endedAtMs: row.endedAt,
    metadata: typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {},
  };
}
