import type { Candle } from "@crypastra/core";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { encodeDecimalString } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { candles } from "../db/schema.js";

export interface UpsertCandleInput {
  readonly candle: Candle;
  readonly provider: string;
  readonly ingestedAtMs: number;
}

export class CandleRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  /**
   * Upsert candle dengan kunci (contract, interval, t).
   *
   * Trade-off yang disengaja: candle yang sudah tertutup boleh ditimpa oleh
   * data yang lebih benar. Karena `window_closed` satu arah (false -> true),
   * penimpaan candle final tidak menghapus informasi; ia mengoreksi. Untuk
   * replay, `market_events` tetap sumber mentah yang tidak pernah ditimpa.
   */
  upsert(input: UpsertCandleInput): void {
    const { candle } = input;
    const row = {
      contract: candle.contract,
      interval: candle.interval,
      t: candle.openTimeSeconds,
      o: encodeDecimalString(candle.o),
      h: encodeDecimalString(candle.h),
      l: encodeDecimalString(candle.l),
      c: encodeDecimalString(candle.c),
      v: candle.v,
      sum: encodeDecimalString(candle.sum),
      windowClosed: candle.windowClosed,
      provider: input.provider,
      ingestedAt: input.ingestedAtMs,
    };

    this.#conn.db
      .insert(candles)
      .values(row)
      .onConflictDoUpdate({
        target: [candles.contract, candles.interval, candles.t],
        set: row,
      })
      .run();
  }

  upsertMany(inputs: readonly UpsertCandleInput[]): void {
    if (inputs.length === 0) {
      return;
    }
    this.#conn.transaction(() => {
      for (const input of inputs) {
        this.upsert(input);
      }
    });
  }

  /** Rentang waktu memakai DETIK (open time candle), sama dengan Gate.io. */
  queryRange(
    contract: string,
    interval: string,
    fromSeconds: number,
    toSeconds: number,
  ): Candle[] {
    return this.#conn.db
      .select()
      .from(candles)
      .where(
        and(
          eq(candles.contract, contract),
          eq(candles.interval, interval),
          gte(candles.t, fromSeconds),
          lte(candles.t, toSeconds),
        ),
      )
      .orderBy(asc(candles.t))
      .all()
      .map(mapCandleRow);
  }

  /** `limit` candle terakhir (urut naik) — dipakai chart untuk bootstrap. */
  listLatest(contract: string, interval: string, limit: number): Candle[] {
    const rows = this.#conn.db
      .select()
      .from(candles)
      .where(and(eq(candles.contract, contract), eq(candles.interval, interval)))
      .orderBy(desc(candles.t))
      .limit(limit)
      .all();
    // Kembalikan urut naik (paling lama → terbaru) untuk chart.
    return rows.reverse().map(mapCandleRow);
  }

  latest(contract: string, interval: string): Candle | null {
    const rows = this.#conn.db
      .select()
      .from(candles)
      .where(and(eq(candles.contract, contract), eq(candles.interval, interval)))
      .orderBy(asc(candles.t))
      .all();
    const row = rows.at(-1);
    return row === undefined ? null : mapCandleRow(row);
  }

  count(): number {
    return this.#conn.db.select({ t: candles.t }).from(candles).all().length;
  }
}

function mapCandleRow(row: typeof candles.$inferSelect): Candle {
  return {
    contract: row.contract,
    interval: row.interval,
    openTimeSeconds: row.t,
    o: row.o,
    h: row.h,
    l: row.l,
    c: row.c,
    v: row.v,
    sum: row.sum,
    windowClosed: row.windowClosed,
  };
}
