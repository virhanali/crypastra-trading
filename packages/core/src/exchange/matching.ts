import { InvalidBookError, InvalidOrderError } from "../errors.js";
import { Decimal, MONEY_DP } from "../money.js";
import type { ContractSpec } from "../contract.js";
import type { BookLevel, BookSnapshot } from "../market.js";
import { feeFor } from "./fee.js";
import { quantizeToTick, roundMarginUp, toContractCount } from "./rounding.js";
import type { Liquidity, OrderIntent, OrderSide, TimeInForce } from "./types.js";

/**
 * Primitif matching MURNI. Belum ada order engine, persistensi, atau mutasi
 * state di sini.
 *
 * Yang SUDAH ditentukan (ACCOUNTING.md §8):
 *  - market order selalu taker
 *  - limit yang menyentuh level lawan = taker; yang tidak menyentuh = resting maker
 *  - harga fill = harga level lawan yang dikonsumsi
 *
 * Yang BELUM terverifikasi (assumption A12):
 *  - kedalaman buku Gate.io cukup untuk mensimulasikan slippage market order
 *    dengan jujur. Model konsumsi level di sini adalah MODEL SIMULATOR.
 */

/** Hubungan limit order terhadap sisi buku lawan. */
export type LimitRelation =
  /** Menyentuh/menembus level lawan → taker fill. */
  | "crosses"
  /** Tidak menyentuh level lawan → resting (maker) atau ditolak (post_only). */
  | "rests";

export interface LevelTake {
  readonly price: Decimal;
  readonly size: number;
}

export interface LevelConsumption {
  readonly takes: readonly LevelTake[];
  readonly filledSize: number;
  readonly remainingSize: number;
}

/** Harga terbaik dari sisi buku (ask terendah / bid tertinggi sesuai urutan). */
export function bestPriceOf(levels: readonly BookLevel[]): Decimal | null {
  const first = levels[0];
  return first === undefined ? null : new Decimal(first.price);
}

/**
 * Apakah limit order menyentuh level lawan pertama.
 * BUY  menyentuh bila limit ≥ best ask.
 * SELL menyentuh bila limit ≤ best bid.
 */
export function limitCrosses(side: OrderSide, limitPrice: Decimal.Value, oppositeBest: Decimal.Value): boolean {
  const limit = new Decimal(limitPrice);
  const best = new Decimal(oppositeBest);
  return side === "buy" ? limit.greaterThanOrEqualTo(best) : limit.lessThanOrEqualTo(best);
}

/** Apakah limit order bisa langsung tereksekusi terhadap sisi buku lawan. */
export function isMarketable(
  side: OrderSide,
  limitPrice: Decimal.Value,
  oppositeLevels: readonly BookLevel[],
): boolean {
  const best = bestPriceOf(oppositeLevels);
  return best !== null && limitCrosses(side, limitPrice, best);
}

/** Level lawan yang layak dikonsumsi oleh limit order pada harga tertentu. */
export function eligibleLevels(
  side: OrderSide,
  oppositeLevels: readonly BookLevel[],
  limitPrice: Decimal.Value | null,
): BookLevel[] {
  if (limitPrice === null) {
    return [...oppositeLevels];
  }
  const limit = new Decimal(limitPrice);
  return oppositeLevels.filter((level) => {
    const price = new Decimal(level.price);
    return side === "buy" ? price.lessThanOrEqualTo(limit) : price.greaterThanOrEqualTo(limit);
  });
}

/**
 * Konsumsi level buku secara berurutan sampai ukuran terpenuhi.
 * Murni: tidak menghitung fee, tidak menyentuh state.
 */
export function planLevelConsumption(
  requestedSize: number,
  levels: readonly BookLevel[],
): LevelConsumption {
  const requested = new Decimal(requestedSize);
  // Sintaktis saja: komponen pecahan diizinkan di sini, dan `assertValidSize`
  // (dipanggil OrderService sebelum matching) yang menegakkan aturan kontrak.
  if (!requested.isFinite() || requested.lessThanOrEqualTo(0)) {
    throw new InvalidOrderError(`Ukuran permintaan harus desimal positif, dapat: ${requestedSize}`);
  }
  const takes: LevelTake[] = [];
  // Akumulasi memakai Decimal supaya cacah kontrak pecahan tidak melayang
  // (mis. 0.3 − 0.1 − 0.1 − 0.1 tepat 0, bukan 2.7e-17).
  let remaining = requested;

  for (const level of levels) {
    if (remaining.lessThanOrEqualTo(0)) {
      break;
    }
    const size = new Decimal(level.size);
    if (!size.isFinite() || size.lessThanOrEqualTo(0)) {
      continue;
    }
    const price = new Decimal(level.price);
    if (price.lessThanOrEqualTo(0)) {
      throw new InvalidBookError(`Harga level buku harus positif, dapat: ${level.price}`);
    }
    const take = Decimal.min(remaining, size);
    takes.push({ price, size: toContractCount(take) });
    remaining = remaining.minus(take);
  }

  return {
    takes,
    filledSize: toContractCount(requested.minus(remaining)),
    remainingSize: toContractCount(remaining),
  };
}

/**
 * Rata-rata harga fill tertimbang ukuran, dikuantisasi ke `order_price_round`.
 *
 * BUG yang diperbaiki di Phase 2: implementasi Phase 0 menghitung
 * `Σ(harga × ukuran × quanto_multiplier) / Σukuran`, yang menghasilkan
 * `quanto_multiplier × harga` — untuk BTC_USDT (0.0001) itu 8.001 alih-alih
 * 80010. Rata-rata harga TIDAK boleh melibatkan `quanto_multiplier`.
 * Regresi: tests/phase2-matching.test.ts.
 */
export function averageFillPrice(spec: ContractSpec, takes: readonly LevelTake[]): Decimal | null {
  const totalSize = takes.reduce((sum, take) => sum + take.size, 0);
  if (takes.length === 0 || totalSize <= 0) {
    return null;
  }
  const weighted = takes.reduce(
    (sum, take) => sum.plus(take.price.times(take.size)),
    new Decimal(0),
  );
  return quantizeToTick(weighted.div(totalSize), spec.orderPriceRound);
}

export interface SimulatedFill {
  readonly price: string;
  readonly size: number;
  readonly liquidity: Liquidity;
  readonly fee: string;
  readonly feeRate: string;
}

export interface MatchResult {
  readonly fills: SimulatedFill[];
  readonly filledSize: number;
  readonly remainingSize: number;
  readonly avgPrice: string | null;
  readonly restsOnBook: boolean;
  readonly rejected: string | null;
}

/**
 * Simulasi matching terhadap snapshot buku. Murni: tidak menyentuh DB/network.
 * Market order = taker. Limit yang menyapu level lawan = taker; yang tidak
 * menyentuh = maker (resting, tanpa fill). post_only yang akan langsung
 * tereksekusi ditolak.
 */
export function simulateFill(
  spec: ContractSpec,
  intent: OrderIntent,
  book: BookSnapshot,
): MatchResult {
  const isBuy = intent.side === "buy";
  const levels = isBuy ? book.asks : book.bids;
  const limitPrice = intent.price === null ? null : new Decimal(intent.price);

  if (intent.type === "limit" && limitPrice === null) {
    throw new InvalidOrderError("Order limit wajib punya harga");
  }
  if (intent.type === "market" && intent.price !== null) {
    throw new InvalidOrderError("Order market tidak boleh punya harga");
  }
  if (!new Decimal(intent.size).isFinite() || intent.size <= 0) {
    throw new InvalidOrderError(`Ukuran order harus desimal positif, dapat: ${intent.size}`);
  }

  const crosses = limitPrice === null ? true : isMarketable(intent.side, limitPrice, levels);

  if (intent.timeInForce === "post_only" && crosses) {
    return {
      fills: [],
      filledSize: 0,
      remainingSize: intent.size,
      avgPrice: null,
      restsOnBook: false,
      rejected: "post_only akan langsung tereksekusi",
    };
  }

  const eligible = eligibleLevels(intent.side, levels, limitPrice);
  const consumption = planLevelConsumption(intent.size, eligible);

  const fills: SimulatedFill[] = consumption.takes.map((take) => {
    const { fee, rate } = feeFor(spec, take.size, take.price, "taker");
    return {
      price: take.price.toFixed(),
      size: take.size,
      liquidity: "taker" as const,
      fee: fee.toFixed(MONEY_DP),
      feeRate: rate.toFixed(),
    };
  });

  const rejected = marketSlipReject(spec, isBuy, book, fills);
  if (rejected !== null) {
    return {
      fills: [],
      filledSize: 0,
      remainingSize: intent.size,
      avgPrice: null,
      restsOnBook: false,
      rejected,
    };
  }

  const avg = averageFillPrice(spec, consumption.takes);
  const restsOnBook =
    consumption.filledSize === 0 && intent.type === "limit" && restsOnRestingSide(intent.timeInForce);

  return {
    fills,
    filledSize: consumption.filledSize,
    remainingSize: consumption.remainingSize,
    avgPrice: avg === null ? null : avg.toFixed(),
    restsOnBook,
    rejected: null,
  };
}

function restsOnRestingSide(tif: TimeInForce): boolean {
  return tif === "gtc" || tif === "post_only";
}

/**
 * Gate.io membatasi slippage order market lewat `market_order_slip_ratio`.
 * Kita menegakkan batas yang sama agar simulasi tidak jauh lebih optimistis
 * dari exchange. Lihat docs/gateio-market-data.md.
 */
function marketSlipReject(
  spec: ContractSpec,
  isBuy: boolean,
  book: BookSnapshot,
  fills: readonly SimulatedFill[],
): string | null {
  const ratio = spec.marketOrderSlipRatio;
  if (ratio === null || fills.length === 0) {
    return null;
  }
  const reference = isBuy ? book.asks[0] : book.bids[0];
  if (reference === undefined) {
    return null;
  }
  const referencePrice = new Decimal(reference.price);
  const worst = fills.reduce<Decimal | null>((acc, fill) => {
    const price = new Decimal(fill.price);
    if (acc === null) {
      return price;
    }
    if (isBuy) {
      return price.greaterThan(acc) ? price : acc;
    }
    return price.lessThan(acc) ? price : acc;
  }, null);
  if (worst === null) {
    return null;
  }

  const deviation = worst.minus(referencePrice).abs().div(referencePrice);
  if (deviation.greaterThan(ratio)) {
    return `slippage ${deviation.toFixed(6)} melebihi batas ${ratio}`;
  }
  return null;
}

/**
 * Margin yang direservasi untuk limit order terbuka = ceil8(notional/leverage).
 * Margin adalah nilai uang, jadi memakai skala akuntansi 8 dp.
 */
export function reservationFor(
  spec: ContractSpec,
  size: number,
  price: Decimal.Value,
  leverage: Decimal.Value,
): Decimal {
  const lev = new Decimal(leverage);
  if (!lev.isFinite() || lev.lessThanOrEqualTo(0)) {
    throw new InvalidOrderError(`Leverage harus positif berhingga, dapat: ${String(leverage)}`);
  }
  const notionalValue = new Decimal(size).times(spec.quantoMultiplier).times(price);
  // Margin = nilai uang; dibulatkan ke atas lewat kebijakan terpusat.
  return roundMarginUp(notionalValue.div(lev));
}
