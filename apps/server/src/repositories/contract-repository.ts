import type { ContractSpec } from "@crypastra/core";
import { asc, eq } from "drizzle-orm";
import { encodeDecimalString } from "../db/decimal-codec.js";
import type { DatabaseConnection } from "../db/database.js";
import { NotFoundError } from "../db/errors.js";
import { contracts } from "../db/schema.js";

export interface UpsertContractInput {
  readonly spec: ContractSpec;
  /** Payload asli dari exchange, untuk audit perubahan spesifikasi. */
  readonly rawJson: string;
  readonly updatedAtMs: number;
}

/**
 * ContractRepository — menyimpan spesifikasi kontrak.
 *
 * `quanto_multiplier` heterogen antar kontrak (0.0001 BTC, 1 untuk banyak
 * altcoin, dst.), jadi nilainya disimpan EKSAK dan TIDAK boleh dinormalisasi ke
 * asumsi BTC. `order_price_round` bisa sampai 11 dp (SATS_USDT), jadi tidak
 * dibulatkan ke skala uang 8 dp.
 *
 * Lihat docs/gateio-market-data.md.
 */
export class ContractRepository {
  readonly #conn: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.#conn = connection;
  }

  upsert(input: UpsertContractInput): ContractSpec {
    const { spec } = input;
    const row = {
      id: spec.contract,
      base: spec.base,
      quote: spec.quote,
      quantoMultiplier: encodeDecimalString(spec.quantoMultiplier),
      orderSizeMin: spec.orderSizeMin,
      orderSizeMax: spec.orderSizeMax,
      enableDecimal: spec.enableDecimal,
      orderPriceRound: encodeDecimalString(spec.orderPriceRound),
      markPriceRound: encodeDecimalString(spec.markPriceRound),
      leverageMin: encodeDecimalString(spec.leverageMin),
      leverageMax: encodeDecimalString(spec.leverageMax),
      maintenanceRate: encodeDecimalString(spec.maintenanceRate),
      makerFeeRate: encodeDecimalString(spec.makerFeeRate),
      takerFeeRate: encodeDecimalString(spec.takerFeeRate),
      fundingIntervalSeconds: spec.fundingIntervalSeconds,
      marketOrderSlipRatio:
        spec.marketOrderSlipRatio === null ? null : encodeDecimalString(spec.marketOrderSlipRatio),
      status: spec.status,
      source: spec.source,
      rawJson: input.rawJson,
      updatedAt: input.updatedAtMs,
    };

    this.#conn.db
      .insert(contracts)
      .values(row)
      .onConflictDoUpdate({ target: contracts.id, set: row })
      .run();

    return spec;
  }

  find(contract: string): ContractSpec | null {
    const row = this.#conn.db.select().from(contracts).where(eq(contracts.id, contract)).get();
    return row === undefined ? null : mapContractRow(row);
  }

  require(contract: string): ContractSpec {
    const spec = this.find(contract);
    if (spec === null) {
      throw new NotFoundError(`Kontrak tidak ditemukan: ${contract}`);
    }
    return spec;
  }

  listActive(): ContractSpec[] {
    return this.#conn.db
      .select()
      .from(contracts)
      .where(eq(contracts.status, "trading"))
      .orderBy(asc(contracts.id))
      .all()
      .map(mapContractRow);
  }

  listAll(): ContractSpec[] {
    return this.#conn.db.select().from(contracts).orderBy(asc(contracts.id)).all().map(mapContractRow);
  }

  count(): number {
    return this.#conn.db.select({ id: contracts.id }).from(contracts).all().length;
  }
}

function mapContractRow(row: typeof contracts.$inferSelect): ContractSpec {
  return {
    contract: row.id,
    base: row.base,
    quote: row.quote,
    quantoMultiplier: row.quantoMultiplier,
    orderSizeMin: row.orderSizeMin,
    orderSizeMax: row.orderSizeMax,
    enableDecimal: row.enableDecimal,
    orderPriceRound: row.orderPriceRound,
    markPriceRound: row.markPriceRound,
    leverageMin: row.leverageMin,
    leverageMax: row.leverageMax,
    maintenanceRate: row.maintenanceRate,
    makerFeeRate: row.makerFeeRate,
    takerFeeRate: row.takerFeeRate,
    fundingIntervalSeconds: row.fundingIntervalSeconds,
    marketOrderSlipRatio: row.marketOrderSlipRatio,
    status: row.status,
    source: row.source,
  };
}
