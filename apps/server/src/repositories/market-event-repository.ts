import { and, asc, eq, gt } from "drizzle-orm";
import type { DatabaseConnection } from "../db/database.js";
import { ValidationError } from "../db/errors.js";
import { marketEvents } from "../db/schema.js";

export interface AppendMarketEventInput {
  readonly provider: string;
  readonly channel: string;
  readonly contract: string;
  readonly eventTsMs: number;
  /** Kunci idempotensi ingest. Lihat `marketDedupeKey`. */
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly ingestedAtMs: number;
}

export interface MarketEventRecord {
  readonly seq: number;
  readonly provider: string;
  readonly channel: string;
  readonly contract: string;
  readonly eventTsMs: number;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly ingestedAtMs: number;
}

export interface AppendMarketEventResult {
  readonly record: MarketEventRecord;
  readonly duplicate: boolean;
}

/**
 * Kunci idempotensi ingest.
 *
 * `discriminator` membedakan event dalam channel yang sama:
 *  - candle  : `${t}` (satu candle per window)
 *  - trade   : id trade
 *  - book    : `u` (update id terakhir)
 *  - ticker  : `t` (milidetik)
 */
export function marketDedupeKey(
  provider: string,
  channel: string,
  contract: string,
  discriminator: string,
): string {
  if (discriminator.trim() === "") {
    throw new ValidationError("discriminator dedupe tidak boleh kosong");
  }
  return `${provider}:${channel}:${contract}:${discriminator}`;
}

/**
 * MarketEventRepository — log append-only event pasar mentah.
 *
 * Ini sumber replay yang jujur: tidak pernah ditimpa (beda dengan `candles`
 * yang merupakan materialisasi), dan urutan `seq` memberi urutan kronologis
 * deterministik untuk replay.
 */
export class MarketEventRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  append(input: AppendMarketEventInput): AppendMarketEventResult {
    if (input.dedupeKey.trim() === "") {
      throw new ValidationError("dedupeKey wajib diisi");
    }
    if (!Number.isInteger(input.eventTsMs) || input.eventTsMs < 0) {
      throw new ValidationError(`eventTsMs harus epoch milidetik integer: ${input.eventTsMs}`);
    }

    return this.#conn.transaction(() => {
      const existing = this.#conn.db
        .select()
        .from(marketEvents)
        .where(eq(marketEvents.dedupeKey, input.dedupeKey))
        .get();
      if (existing !== undefined) {
        return { record: mapMarketEventRow(existing), duplicate: true };
      }

      const inserted = this.#conn.db
        .insert(marketEvents)
        .values({
          provider: input.provider,
          channel: input.channel,
          contract: input.contract,
          eventTs: input.eventTsMs,
          dedupeKey: input.dedupeKey,
          payloadJson: JSON.stringify(input.payload),
          ingestedAt: input.ingestedAtMs,
        })
        .returning()
        .get();

      return { record: mapMarketEventRow(inserted), duplicate: false };
    });
  }

  /** Urut naik berdasarkan `seq` = urutan ingest = urutan kronologis replay. */
  list(
    contract: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): MarketEventRecord[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 1000;
    return this.#conn.db
      .select()
      .from(marketEvents)
      .where(
        afterSeq > 0
          ? and(eq(marketEvents.contract, contract), gt(marketEvents.seq, afterSeq))
          : eq(marketEvents.contract, contract),
      )
      .orderBy(asc(marketEvents.seq))
      .limit(limit)
      .all()
      .map(mapMarketEventRow);
  }

  count(): number {
    return this.#conn.db.select({ seq: marketEvents.seq }).from(marketEvents).all().length;
  }
}

function mapMarketEventRow(row: typeof marketEvents.$inferSelect): MarketEventRecord {
  return {
    seq: row.seq,
    provider: row.provider,
    channel: row.channel,
    contract: row.contract,
    eventTsMs: row.eventTs,
    dedupeKey: row.dedupeKey,
    payload: JSON.parse(row.payloadJson) as unknown,
    ingestedAtMs: row.ingestedAt,
  };
}
