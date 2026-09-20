import {
  assertTransition,
  quantizeToTick,
  statusAfterExecution,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type TimeInForce,
} from "@crypastra/core";
import { Decimal } from "@crypastra/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { decodeExact, decodeMoney, encodeDecimalString, encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { orderEvents, orders } from "../db/schema.js";

const ZERO = new Decimal(0);

export interface OrderRecord {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly size: number;
  readonly price: Decimal | null;
  readonly reduceOnly: boolean;
  readonly leverage: Decimal;
  readonly status: OrderStatus;
  readonly rejectReason: string | null;
  readonly filledSize: number;
  readonly avgFillPrice: Decimal | null;
  readonly reservedMargin: Decimal;
  readonly tpPrice: Decimal | null;
  readonly slPrice: Decimal | null;
  /** Audit saja. Tidak pernah dibaca logika ekonomi. */
  readonly source: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InsertOrderInput {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly intent: {
    readonly side: OrderSide;
    readonly type: OrderType;
    readonly timeInForce: TimeInForce;
    readonly size: number;
    readonly price: string | null;
    readonly leverage: string;
    readonly reduceOnly: boolean;
    readonly tpPrice: string | null;
    readonly slPrice: string | null;
  };
  readonly source: string;
  readonly tsMs: number;
}

export interface OrderEventRecord {
  readonly seq: number;
  readonly orderId: string;
  readonly type: string;
  readonly detail: Record<string, unknown>;
  readonly tsMs: number;
}

/**
 * OrderRepository — pemilik tabel `orders` dan `order_events`.
 *
 * Tidak ada `update()` generik. Mutasi finansial hanya lewat metode bernama
 * (status, fill, reservasi), dan setiap perubahan status melewati state machine
 * sehingga transisi ilegal gagal eksplisit.
 */
export class OrderRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  insert(input: InsertOrderInput): OrderRecord {
    // HANYA validasi sintaktis di sini. Aturan integer per kontrak ditegakkan
    // `#validateIntent` (OrderService) SESUDAH baris order dibuat, supaya
    // penolakan tetap terekam untuk audit (`order.created` → `rejected`).
    // Menegakkannya di sini akan mengubah penolakan ber-audit menjadi exception.
    if (!new Decimal(input.intent.size).isFinite() || input.intent.size <= 0) {
      throw new ValidationError(`Ukuran order harus desimal positif: ${input.intent.size}`);
    }
    this.#conn.db
      .insert(orders)
      .values({
        id: input.id,
        accountId: input.accountId,
        contract: input.contract,
        side: input.intent.side,
        type: input.intent.type,
        timeInForce: input.intent.timeInForce,
        size: input.intent.size,
        price: input.intent.price === null ? null : encodeDecimalString(input.intent.price),
        reduceOnly: input.intent.reduceOnly,
        leverage: encodeDecimalString(input.intent.leverage),
        status: "created",
        rejectReason: null,
        filledSize: 0,
        avgFillPrice: null,
        reservedMargin: null,
        tpPrice: input.intent.tpPrice === null ? null : encodeDecimalString(input.intent.tpPrice),
        slPrice: input.intent.slPrice === null ? null : encodeDecimalString(input.intent.slPrice),
        source: input.source,
        createdAt: input.tsMs,
        updatedAt: input.tsMs,
      })
      .run();

    this.appendEvent({ orderId: input.id, type: "created", detail: {}, tsMs: input.tsMs });
    return this.require(input.id);
  }

  find(id: string): OrderRecord | null {
    const row = this.#conn.db.select().from(orders).where(eq(orders.id, id)).get();
    return row === undefined ? null : mapOrderRow(row);
  }

  require(id: string): OrderRecord {
    const found = this.find(id);
    if (found === null) {
      throw new NotFoundError(`Order tidak ditemukan: ${id}`);
    }
    return found;
  }

  listByAccount(accountId: string, options: { limit?: number } = {}): OrderRecord[] {
    return this.#conn.db
      .select()
      .from(orders)
      .where(eq(orders.accountId, accountId))
      .orderBy(sql`rowid desc`)
      .limit(options.limit ?? 500)
      .all()
      .map(mapOrderRow);
  }

  /** Order yang masih bisa terisi (limit gtc/post_only dengan status open/partially_filled). */
  listLive(accountId?: string): OrderRecord[] {
    const liveStatuses: OrderStatus[] = ["open", "partially_filled"];
    const where =
      accountId === undefined
        ? and(inArray(orders.status, liveStatuses), eq(orders.type, "limit"))
        : and(
            inArray(orders.status, liveStatuses),
            eq(orders.type, "limit"),
            eq(orders.accountId, accountId),
          );
    return this.#conn.db
      .select()
      .from(orders)
      .where(where)
      .orderBy(sql`rowid asc`)
      .all()
      .map(mapOrderRow);
  }

  /**
   * Ubah status dengan validasi state machine. Event hanya ditulis bila status
   * benar-benar berubah.
   */
  setStatus(input: {
    orderId: string;
    to: OrderStatus;
    tsMs: number;
    reason?: string;
    detail?: Record<string, unknown>;
  }): OrderRecord {
    const current = this.require(input.orderId);
    if (current.status === input.to) {
      // Tidak ada transisi. Tidak ada event: peristiwa yang menyebabkannya
      // (mis. fill) sudah punya event sendiri.
      return current;
    }
    assertTransition(current.status, input.to);

    this.#conn.db
      .update(orders)
      .set({
        status: input.to,
        updatedAt: input.tsMs,
        ...(input.reason === undefined ? {} : { rejectReason: input.reason }),
      })
      .where(eq(orders.id, input.orderId))
      .run();

    this.appendEvent({
      orderId: input.orderId,
      type: statusEventType(input.to),
      detail: { from: current.status, to: input.to, ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.detail ?? {}) },
      tsMs: input.tsMs,
    });
    return this.require(input.orderId);
  }

  /**
   * Catat fill pada order: tambah filledSize dan hitung ulang rata-rata harga
   * tertimbang UKURAN (Σharga×size / Σsize). `quanto_multiplier` TIDAK boleh
   * ikut, karena itu menghasilkan harga yang salah (lihat ADR 0006).
   */
  recordFill(input: {
    orderId: string;
    fillSize: number;
    fillPrice: Decimal;
    /** Tick harga kontrak, untuk kuantisasi rata-rata. */
    priceRound: string;
    tsMs: number;
    fillId: string;
  }): OrderRecord {
    const current = this.require(input.orderId);
    if (input.fillSize <= 0) {
      throw new ValidationError(`Ukuran fill harus positif: ${input.fillSize}`);
    }
    const newFilled = current.filledSize + input.fillSize;
    if (newFilled > current.size) {
      throw new ValidationError(
        `Fill melebihi ukuran order: ${newFilled} > ${current.size} untuk ${input.orderId}`,
      );
    }

    const weighted =
      current.avgFillPrice === null
        ? input.fillPrice.times(input.fillSize)
        : current.avgFillPrice.times(current.filledSize).plus(input.fillPrice.times(input.fillSize));
    const avg = quantizeToTick(weighted.div(newFilled), input.priceRound);

    this.#conn.db
      .update(orders)
      .set({
        filledSize: newFilled,
        avgFillPrice: encodeDecimalString(avg),
        updatedAt: input.tsMs,
      })
      .where(eq(orders.id, input.orderId))
      .run();

    this.appendEvent({
      orderId: input.orderId,
      type: "fill",
      detail: { fillId: input.fillId, size: String(input.fillSize), price: input.fillPrice.toString(), filledSize: String(newFilled) },
      tsMs: input.tsMs,
    });
    return this.require(input.orderId);
  }

  /** Status yang seharusnya setelah eksekusi, berdasarkan ukuran terisi. */
  statusAfterFilled(input: { orderId: string; filledSize: number }): OrderStatus {
    const current = this.require(input.orderId);
    return statusAfterExecution({
      type: current.type,
      timeInForce: current.timeInForce,
      filledSize: input.filledSize,
      requestedSize: current.size,
    });
  }

  /** Sisa reservasi margin order ini (per-order view). */
  setReservedMargin(input: { orderId: string; reservedMargin: Decimal; tsMs: number }): OrderRecord {
    if (input.reservedMargin.isNegative()) {
      throw new ValidationError(
        `Reservasi margin tidak boleh negatif: ${input.reservedMargin.toString()}`,
      );
    }
    this.#conn.db
      .update(orders)
      .set({ reservedMargin: encodeMoney(input.reservedMargin), updatedAt: input.tsMs })
      .where(eq(orders.id, input.orderId))
      .run();
    return this.require(input.orderId);
  }

  appendEvent(input: {
    orderId: string;
    type: string;
    detail: Record<string, unknown>;
    tsMs: number;
  }): void {
    this.#conn.db
      .insert(orderEvents)
      .values({
        orderId: input.orderId,
        type: input.type,
        detailJson: JSON.stringify(input.detail),
        ts: input.tsMs,
      })
      .run();
  }

  events(orderId: string): OrderEventRecord[] {
    return this.#conn.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(asc(orderEvents.seq))
      .all()
      .map((row) => ({
        seq: row.seq,
        orderId: row.orderId,
        type: row.type,
        detail: JSON.parse(row.detailJson) as Record<string, unknown>,
        tsMs: row.ts,
      }));
  }

  count(): number {
    return this.#conn.db.select({ id: orders.id }).from(orders).all().length;
  }
}

function statusEventType(status: OrderStatus): string {
  return status;
}

function mapOrderRow(row: typeof orders.$inferSelect): OrderRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    contract: row.contract,
    side: row.side,
    type: row.type,
    timeInForce: row.timeInForce,
    size: row.size,
    price: row.price === null ? null : decodeExact(row.price),
    reduceOnly: row.reduceOnly,
    leverage: decodeExact(row.leverage),
    status: row.status,
    rejectReason: row.rejectReason,
    filledSize: row.filledSize,
    avgFillPrice: row.avgFillPrice === null ? null : decodeExact(row.avgFillPrice),
    reservedMargin: row.reservedMargin === null ? ZERO : decodeMoney(row.reservedMargin),
    tpPrice: row.tpPrice === null ? null : decodeExact(row.tpPrice),
    slPrice: row.slPrice === null ? null : decodeExact(row.slPrice),
    source: row.source,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
  };
}
