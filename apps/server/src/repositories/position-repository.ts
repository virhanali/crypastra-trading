import { Decimal } from "@crypastra/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { decodeExact, decodeMoney, encodeDecimalString, encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { ContractRepository } from "./contract-repository.js";
import { NotFoundError, ValidationError } from "../db/errors.js";
import { positionEvents, positions } from "../db/schema.js";
import type { Direction, PositionStatus } from "@crypastra/core";

const ZERO = new Decimal(0);

export interface PositionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly direction: Direction;
  readonly status: PositionStatus;
  readonly size: number;
  readonly entryPrice: Decimal;
  readonly leverage: Decimal;
  readonly initialMargin: Decimal;
  readonly accumulatedFunding: Decimal;
  readonly feesPaid: Decimal;
  readonly realizedPnl: Decimal;
  readonly tpPrice: Decimal | null;
  readonly slPrice: Decimal | null;
  readonly liquidationPrice: Decimal | null;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly closeReason: string | null;
}

export interface PositionEventRecord {
  readonly seq: number;
  readonly positionId: string;
  readonly type: string;
  readonly detail: Record<string, unknown>;
  readonly tsMs: number;
}

export interface CreatePositionInput {
  readonly id: string;
  readonly accountId: string;
  readonly contract: string;
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: Decimal;
  readonly leverage: Decimal;
  readonly initialMargin: Decimal;
  readonly tpPrice?: Decimal | null;
  readonly slPrice?: Decimal | null;
  readonly tsMs: number;
}

/**
 * PositionRepository — pemilik `positions` dan `position_events`.
 *
 * Mutasi finansial hanya lewat metode bernama (increase/reduce/close). Tidak ada
 * `update()` generik. Setiap mutasi menulis position_event.
 */
export class PositionRepository {
  readonly #conn: DatabaseConnection;
  readonly #contracts: ContractRepository;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
    this.#contracts = new ContractRepository(connection);
  }

  create(input: CreatePositionInput): PositionRecord {
    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new ValidationError(`Ukuran posisi harus desimal positif: ${input.size}`);
    }
    // Ukuran integer sah untuk semua kontrak. Lookup kontrak hanya diperlukan
    // untuk ukuran pecahan (kontrak desimal), sehingga jalur integer tetap
    // secepat sebelumnya.
    if (!Number.isInteger(input.size)) {
      const spec = this.#contracts.find(input.contract);
      if (spec === null) {
        throw new ValidationError(`Kontrak ${input.contract} tidak dikenal di DB`);
      }
      if (!spec.enableDecimal) {
        throw new ValidationError(
          `Ukuran posisi harus integer untuk ${input.contract} (enable_decimal=false): ${input.size}`,
        );
      }
    }
    this.#conn.db
      .insert(positions)
      .values({
        id: input.id,
        accountId: input.accountId,
        contract: input.contract,
        direction: input.direction,
        status: "open",
        size: input.size,
        entryPrice: encodeDecimalString(input.entryPrice),
        leverage: encodeDecimalString(input.leverage),
        initialMargin: encodeMoney(input.initialMargin),
        accumulatedFunding: encodeMoney(ZERO),
        feesPaid: encodeMoney(ZERO),
        realizedPnl: encodeMoney(ZERO),
        tpPrice: input.tpPrice === undefined || input.tpPrice === null ? null : encodeDecimalString(input.tpPrice),
        slPrice: input.slPrice === undefined || input.slPrice === null ? null : encodeDecimalString(input.slPrice),
        liquidationPrice: null,
        openedAt: input.tsMs,
        closedAt: null,
        closeReason: null,
      })
      .run();

    this.appendEvent({
      positionId: input.id,
      type: "opened",
      detail: {
        direction: input.direction,
        size: String(input.size),
        entryPrice: input.entryPrice.toString(),
        initialMargin: encodeMoney(input.initialMargin),
      },
      tsMs: input.tsMs,
    });
    return this.require(input.id);
  }

  find(id: string): PositionRecord | null {
    const row = this.#conn.db.select().from(positions).where(eq(positions.id, id)).get();
    return row === undefined ? null : mapPositionRow(row);
  }

  require(id: string): PositionRecord {
    const found = this.find(id);
    if (found === null) {
      throw new NotFoundError(`Posisi tidak ditemukan: ${id}`);
    }
    return found;
  }

  findOpen(accountId: string, contract: string): PositionRecord | null {
    const row = this.#conn.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.accountId, accountId),
          eq(positions.contract, contract),
          eq(positions.status, "open"),
        ),
      )
      .orderBy(sql`rowid asc`)
      .get();
    return row === undefined ? null : mapPositionRow(row);
  }

  listOpen(accountId: string): PositionRecord[] {
    return this.#conn.db
      .select()
      .from(positions)
      .where(and(eq(positions.accountId, accountId), eq(positions.status, "open")))
      .orderBy(sql`rowid asc`)
      .all()
      .map(mapPositionRow);
  }

  /**
   * Posisi TERBUKA untuk satu kontrak lintas akun.
   *
   * Dipakai pemroses risiko live: saat mark kontrak berubah, hanya akun yang
   * punya posisi terbuka di kontrak itu yang perlu diproses — bukan seluruh akun.
   */
  listOpenByContract(contract: string): PositionRecord[] {
    return this.#conn.db
      .select()
      .from(positions)
      .where(and(eq(positions.contract, contract), eq(positions.status, "open")))
      .orderBy(sql`rowid asc`)
      .all()
      .map(mapPositionRow);
  }

  /** Semua posisi akun (termasuk yang sudah tertutup), terbaru dulu. */
  listByAccount(accountId: string, options: { limit?: number } = {}): PositionRecord[] {
    return this.#conn.db
      .select()
      .from(positions)
      .where(eq(positions.accountId, accountId))
      .orderBy(sql`rowid desc`)
      .limit(options.limit ?? 500)
      .all()
      .map(mapPositionRow);
  }

  /** Menambah eksposur searah (entry rata-rata sudah dihitung pemanggil). */
  applyIncrease(input: {
    positionId: string;
    newSize: number;
    newEntryPrice: Decimal;
    newInitialMargin: Decimal;
    addedMargin: Decimal;
    fee: Decimal;
    tsMs: number;
    detail?: Record<string, unknown>;
  }): PositionRecord {
    const current = this.require(input.positionId);
    assertOpen(current);
    if (input.newSize <= current.size) {
      throw new ValidationError(
        `applyIncrease harus menambah ukuran: ${input.newSize} <= ${current.size}`,
      );
    }
    this.#conn.db
      .update(positions)
      .set({
        size: input.newSize,
        entryPrice: encodeDecimalString(input.newEntryPrice),
        initialMargin: encodeMoney(input.newInitialMargin),
        feesPaid: encodeMoney(current.feesPaid.plus(input.fee)),
      })
      .where(eq(positions.id, input.positionId))
      .run();

    this.appendEvent({
      positionId: input.positionId,
      type: "increased",
      detail: { fromSize: String(current.size), toSize: String(input.newSize), entryPrice: input.newEntryPrice.toString(), ...(input.detail ?? {}) },
      tsMs: input.tsMs,
    });
    return this.require(input.positionId);
  }

  /** Mengurangi eksposur dan merealisasikan PnL sebagian. */
  applyReduce(input: {
    positionId: string;
    newSize: number;
    newInitialMargin: Decimal;
    releasedMargin: Decimal;
    realizedPnl: Decimal;
    fee: Decimal;
    tsMs: number;
    detail?: Record<string, unknown>;
  }): PositionRecord {
    const current = this.require(input.positionId);
    assertOpen(current);
    if (input.newSize >= current.size || input.newSize < 0) {
      throw new ValidationError(
        `applyReduce harus mengurangi ukuran tanpa negatif: ${input.newSize} dari ${current.size}`,
      );
    }
    if (input.releasedMargin.greaterThan(current.initialMargin)) {
      throw new ValidationError(
        `Pelepasan margin melebihi margin posisi: ${input.releasedMargin.toString()} > ${current.initialMargin.toString()}`,
      );
    }
    this.#conn.db
      .update(positions)
      .set({
        size: input.newSize,
        initialMargin: encodeMoney(input.newInitialMargin),
        feesPaid: encodeMoney(current.feesPaid.plus(input.fee)),
        realizedPnl: encodeMoney(current.realizedPnl.plus(input.realizedPnl)),
      })
      .where(eq(positions.id, input.positionId))
      .run();

    this.appendEvent({
      positionId: input.positionId,
      type: "reduced",
      detail: {
        fromSize: String(current.size),
        toSize: String(input.newSize),
        releasedMargin: encodeMoney(input.releasedMargin),
        realizedPnl: encodeMoney(input.realizedPnl),
        ...(input.detail ?? {}),
      },
      tsMs: input.tsMs,
    });
    return this.require(input.positionId);
  }

  /** Menutup posisi sepenuhnya. */
  applyClose(input: {
    positionId: string;
    realizedPnl: Decimal;
    fee: Decimal;
    releasedMargin: Decimal;
    closeReason: string;
    tsMs: number;
    detail?: Record<string, unknown>;
  }): PositionRecord {
    const current = this.require(input.positionId);
    assertOpen(current);
    if (input.releasedMargin.greaterThan(current.initialMargin)) {
      throw new ValidationError(
        `Pelepasan margin penutupan melebihi margin posisi: ${input.releasedMargin.toString()} > ${current.initialMargin.toString()}`,
      );
    }
    this.#conn.db
      .update(positions)
      .set({
        status: "closed",
        size: 0,
        initialMargin: encodeMoney(ZERO),
        feesPaid: encodeMoney(current.feesPaid.plus(input.fee)),
        realizedPnl: encodeMoney(current.realizedPnl.plus(input.realizedPnl)),
        closedAt: input.tsMs,
        closeReason: input.closeReason,
      })
      .where(eq(positions.id, input.positionId))
      .run();

    this.appendEvent({
      positionId: input.positionId,
      type: "closed",
      detail: {
        closedSize: String(current.size),
        realizedPnl: encodeMoney(input.realizedPnl),
        releasedMargin: encodeMoney(input.releasedMargin),
        closeReason: input.closeReason,
        ...(input.detail ?? {}),
      },
      tsMs: input.tsMs,
    });
    return this.require(input.positionId);
  }

  /**
   * Ubah TP/SL posisi terbuka. Mutasi domain-spesifik (bukan update generik),
   * dan menulis `position_events` supaya perubahan tetap auditable.
   */
  applyProtection(input: {
    positionId: string;
    takeProfitPrice: Decimal | null;
    stopLossPrice: Decimal | null;
    tsMs: number;
    detail?: Record<string, unknown>;
  }): PositionRecord {
    const current = this.require(input.positionId);
    assertOpen(current);
    this.#conn.db
      .update(positions)
      .set({
        tpPrice:
          input.takeProfitPrice === null ? null : encodeDecimalString(input.takeProfitPrice),
        slPrice:
          input.stopLossPrice === null ? null : encodeDecimalString(input.stopLossPrice),
      })
      .where(eq(positions.id, input.positionId))
      .run();

    this.appendEvent({
      positionId: input.positionId,
      type: "protection_updated",
      detail: {
        previousTakeProfit: current.tpPrice === null ? null : current.tpPrice.toString(),
        previousStopLoss: current.slPrice === null ? null : current.slPrice.toString(),
        takeProfitPrice: input.takeProfitPrice === null ? null : input.takeProfitPrice.toString(),
        stopLossPrice: input.stopLossPrice === null ? null : input.stopLossPrice.toString(),
        ...(input.detail ?? {}),
      },
      tsMs: input.tsMs,
    });
    return this.require(input.positionId);
  }

  /** Total margin posisi terbuka, untuk invariant 2. */
  totalOpenMargin(accountId: string): Decimal {
    return this.listOpen(accountId).reduce((sum, position) => sum.plus(position.initialMargin), ZERO);
  }

  /** Total ukuran eksposur terbuka per kontrak (netto, selalu >= 0). */
  openExposure(accountId: string, contract: string): number {
    const position = this.findOpen(accountId, contract);
    return position === null ? 0 : position.size;
  }

  appendEvent(input: {
    positionId: string;
    type: string;
    detail: Record<string, unknown>;
    tsMs: number;
  }): void {
    this.#conn.db
      .insert(positionEvents)
      .values({
        positionId: input.positionId,
        type: input.type,
        detailJson: JSON.stringify(input.detail),
        ts: input.tsMs,
      })
      .run();
  }

  events(positionId: string): PositionEventRecord[] {
    return this.#conn.db
      .select()
      .from(positionEvents)
      .where(eq(positionEvents.positionId, positionId))
      .orderBy(asc(positionEvents.seq))
      .all()
      .map((row) => ({
        seq: row.seq,
        positionId: row.positionId,
        type: row.type,
        detail: JSON.parse(row.detailJson) as Record<string, unknown>,
        tsMs: row.ts,
      }));
  }

  count(): number {
    return this.#conn.db.select({ id: positions.id }).from(positions).all().length;
  }
}

function assertOpen(position: PositionRecord): void {
  if (position.status !== "open") {
    throw new ValidationError(
      `Posisi ${position.id} berstatus ${position.status}, hanya posisi open yang boleh diubah`,
    );
  }
}

function mapPositionRow(row: typeof positions.$inferSelect): PositionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    contract: row.contract,
    direction: row.direction,
    status: row.status,
    size: row.size,
    entryPrice: decodeExact(row.entryPrice),
    leverage: decodeExact(row.leverage),
    initialMargin: decodeMoney(row.initialMargin),
    accumulatedFunding: decodeMoney(row.accumulatedFunding),
    feesPaid: decodeMoney(row.feesPaid),
    realizedPnl: decodeMoney(row.realizedPnl),
    tpPrice: row.tpPrice === null ? null : decodeExact(row.tpPrice),
    slPrice: row.slPrice === null ? null : decodeExact(row.slPrice),
    liquidationPrice: row.liquidationPrice === null ? null : decodeExact(row.liquidationPrice),
    openedAtMs: row.openedAt,
    closedAtMs: row.closedAt,
    closeReason: row.closeReason,
  };
}
