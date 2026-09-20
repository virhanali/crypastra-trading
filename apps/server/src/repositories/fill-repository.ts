import { Decimal, type Liquidity, type OrderSide } from "@crypastra/core";
import { desc, eq, sql } from "drizzle-orm";
import { decodeExact, decodeMoney, encodeDecimalString, encodeMoney } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { ContractRepository } from "./contract-repository.js";
import { ValidationError } from "../db/errors.js";
import { fills } from "../db/schema.js";

export interface FillRecord {
  readonly id: string;
  readonly orderId: string | null;
  readonly positionId: string | null;
  readonly contract: string;
  readonly side: OrderSide;
  readonly size: number;
  readonly price: Decimal;
  readonly liquidity: Liquidity;
  readonly fee: Decimal;
  readonly feeRate: Decimal;
  readonly feeAsset: string;
  readonly realizedPnl: Decimal;
  readonly isLiquidation: boolean;
  readonly isTpSl: boolean;
  readonly tsMs: number;
}

export interface AppendFillInput {
  readonly id: string;
  /** null = fill penutupan paksa (TP/SL/likuidasi) yang tidak berasal dari order. */
  readonly orderId: string | null;
  readonly positionId: string | null;
  readonly contract: string;
  readonly side: OrderSide;
  readonly size: number;
  readonly price: Decimal;
  readonly liquidity: Liquidity;
  readonly fee: Decimal;
  readonly feeRate: Decimal;
  readonly feeAsset?: string;
  readonly realizedPnl: Decimal;
  readonly isLiquidation?: boolean;
  readonly isTpSl?: boolean;
  readonly tsMs: number;
}

/** FillRepository — append-only. Tidak ada update/delete fill. */
export class FillRepository {
  readonly #conn: DatabaseConnection;

  readonly #contracts: ContractRepository;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
    this.#contracts = new ContractRepository(connection);
  }

  append(input: AppendFillInput): FillRecord {
    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new ValidationError(`Ukuran fill harus desimal positif: ${input.size}`);
    }
    // Ukuran integer sah untuk SEMUA kontrak, jadi tidak perlu lookup.
    // Aturan kontrak hanya relevan untuk ukuran pecahan (kontrak desimal).
    if (!Number.isInteger(input.size)) {
      const spec = this.#contracts.find(input.contract);
      if (spec === null) {
        throw new ValidationError(`Kontrak ${input.contract} tidak dikenal di DB`);
      }
      if (!spec.enableDecimal) {
        throw new ValidationError(
          `Ukuran fill harus integer untuk ${input.contract} (enable_decimal=false): ${input.size}`,
        );
      }
    }
    this.#conn.db
      .insert(fills)
      .values({
        id: input.id,
        orderId: input.orderId,
        positionId: input.positionId,
        contract: input.contract,
        side: input.side,
        size: input.size,
        price: encodeDecimalString(input.price),
        liquidity: input.liquidity,
        fee: encodeMoney(input.fee),
        feeRate: encodeDecimalString(input.feeRate),
        feeAsset: input.feeAsset ?? "USDT",
        realizedPnl: encodeMoney(input.realizedPnl),
        isLiquidation: input.isLiquidation ?? false,
        isTpSl: input.isTpSl ?? false,
        ts: input.tsMs,
      })
      .run();
    return this.require(input.id);
  }

  setPositionId(fillId: string, positionId: string): void {
    this.#conn.db.update(fills).set({ positionId }).where(eq(fills.id, fillId)).run();
  }

  find(id: string): FillRecord | null {
    const row = this.#conn.db.select().from(fills).where(eq(fills.id, id)).get();
    return row === undefined ? null : mapFillRow(row);
  }

  require(id: string): FillRecord {
    const found = this.find(id);
    if (found === null) {
      throw new ValidationError(`Fill tidak ditemukan: ${id}`);
    }
    return found;
  }

  listByOrder(orderId: string): FillRecord[] {
    return this.#conn.db
      .select()
      .from(fills)
      .where(eq(fills.orderId, orderId))
      .orderBy(sql`rowid asc`)
      .all()
      .map(mapFillRow);
  }

  listByPosition(positionId: string): FillRecord[] {
    return this.#conn.db
      .select()
      .from(fills)
      .where(eq(fills.positionId, positionId))
      .orderBy(sql`rowid asc`)
      .all()
      .map(mapFillRow);
  }

  /**
   * Fill milik satu akun. Tabel `fills` tidak punya `account_id`, jadi akun
   * ditelusuri lewat order ATAU posisi (fill penutupan paksa tidak punya order).
   */
  listByAccount(accountId: string, options: { limit?: number } = {}): FillRecord[] {
    const rows = this.#conn.sqlite
      .query(
        `SELECT f.* FROM fills f
           LEFT JOIN orders o ON o.id = f.order_id
           LEFT JOIN positions p ON p.id = f.position_id
          WHERE o.account_id = ? OR p.account_id = ?
          ORDER BY f.rowid DESC
          LIMIT ?`,
      )
      .all(accountId, accountId, options.limit ?? 500) as Array<Record<string, unknown>>;
    return rows.map((row) => this.require(String(row.id)));
  }

  listByContract(contract: string, options: { limit?: number } = {}): FillRecord[] {
    return this.#conn.db
      .select()
      .from(fills)
      .where(eq(fills.contract, contract))
      .orderBy(desc(fills.ts))
      .limit(options.limit ?? 500)
      .all()
      .map(mapFillRow);
  }

  /** Σ ukuran fill sebuah order, untuk memeriksa invariant 3. */
  totalSizeForOrder(orderId: string): number {
    const rows = this.listByOrder(orderId);
    return rows.reduce((sum, fill) => sum + fill.size, 0);
  }

  totalFeeForOrder(orderId: string): Decimal {
    return this.listByOrder(orderId).reduce((sum, fill) => sum.plus(fill.fee), new Decimal(0));
  }

  count(): number {
    return this.#conn.db.select({ id: fills.id }).from(fills).all().length;
  }
}

function mapFillRow(row: typeof fills.$inferSelect): FillRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    positionId: row.positionId,
    contract: row.contract,
    side: row.side,
    size: row.size,
    price: decodeExact(row.price),
    liquidity: row.liquidity,
    fee: decodeMoney(row.fee),
    feeRate: decodeExact(row.feeRate),
    feeAsset: row.feeAsset,
    realizedPnl: decodeMoney(row.realizedPnl),
    isLiquidation: row.isLiquidation,
    isTpSl: row.isTpSl,
    tsMs: row.ts,
  };
}
