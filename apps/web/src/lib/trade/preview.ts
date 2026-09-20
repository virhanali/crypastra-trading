import type { ContractDto } from "../api/types.js";
import { Decimal, dec, isDecimal, isTickAligned, roundUpMoney } from "./decimal.js";

/**
 * Mesin PREVIEW order (murni, dapat diuji terpisah).
 *
 * Batas yang disengaja: modul ini TIDAK mengimplementasikan mesin exchange kedua.
 * Ia tidak menghitung transisi posisi, settlement PnL, likuidasi, funding, atau
 * mutasi dompet. Ia hanya menghitung angka yang dibutuhkan manusia untuk menilai
 * sebuah order sebelum dikirim, mengikuti aturan pembulatan core (margin/fee ke
 * atas, 8 dp) supaya estimasi tidak menyesatkan.
 *
 * Hasil preview TIDAK PERNAH dikirim ke API; API menerima nilai mentah.
 */

export type TicketSide = "buy" | "sell";
export type TicketType = "market" | "limit";

export interface MarketQuote {
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly bestBidSize: number | null;
  readonly bestAskSize: number | null;
  readonly markPrice: string | null;
}

export interface OrderPreviewInput {
  readonly spec: ContractDto | null;
  readonly side: TicketSide;
  readonly type: TicketType;
  readonly size: string;
  readonly leverage: string;
  readonly limitPrice: string | null;
  readonly takeProfitPrice: string | null;
  readonly stopLossPrice: string | null;
  readonly market: MarketQuote;
  readonly availableBalance: string | null;
}

export interface OrderPreview {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];

  /** true = limit akan langsung tereksekusi terhadap kutipan saat ini. */
  readonly marketable: boolean;
  /** Klasifikasi fee yang diperkirakan: taker untuk market/marketable. */
  readonly liquidity: "maker" | "taker" | null;

  readonly referencePrice: string | null;
  readonly estimatedEntry: string | null;
  readonly baseQuantity: string | null;
  readonly notional: string | null;
  readonly estimatedMargin: string | null;
  readonly estimatedFee: string | null;
  readonly estimatedReservation: string | null;

  /** Ukuran yang diketahui dapat dieksekusi dari puncak buku (market saja). */
  readonly knownExecutableSize: number | null;
  readonly insufficientKnownLiquidity: boolean;
  readonly insufficientBalance: boolean;
}

const ZERO = new Decimal(0);

export function buildOrderPreview(input: OrderPreviewInput): OrderPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { spec } = input;

  if (spec === null) {
    return emptyPreview(["Kontrak belum dipilih"], ["Pilih kontrak terlebih dahulu"]);
  }

  // ── Ukuran kontrak ────────────────────────────────────────────
  let size: Decimal | null = null;
  if (!isDecimal(input.size)) {
    errors.push("Size harus berupa angka desimal");
  } else {
    size = dec(input.size);
    if (size.lessThanOrEqualTo(0)) {
      errors.push("Size harus lebih besar dari 0");
    } else if (!spec.enableDecimal && !size.isInteger()) {
      // Kontrak non-desimal hanya menerima cacah kontrak bulat.
      errors.push(`${spec.contract} hanya menerima size bulat (enable_decimal=false)`);
    } else if (size.lessThan(spec.orderSizeMin)) {
      errors.push(`Size minimum ${spec.orderSizeMin} kontrak`);
    } else if (size.greaterThan(spec.orderSizeMax)) {
      errors.push(`Size maksimum ${spec.orderSizeMax} kontrak`);
    }
  }

  // ── Leverage ──────────────────────────────────────────────────
  let leverage: Decimal | null = null;
  if (!isDecimal(input.leverage)) {
    errors.push("Leverage harus berupa angka desimal");
  } else {
    leverage = dec(input.leverage);
    if (leverage.lessThan(dec(spec.leverageMin)) || leverage.greaterThan(dec(spec.leverageMax))) {
      errors.push(`Leverage harus antara ${spec.leverageMin}× dan ${spec.leverageMax}×`);
    }
  }

  // ── Harga limit ───────────────────────────────────────────────
  let limitPrice: Decimal | null = null;
  if (input.type === "limit") {
    if (input.limitPrice === null || !isDecimal(input.limitPrice)) {
      errors.push("Order limit wajib memiliki harga");
    } else {
      limitPrice = dec(input.limitPrice);
      if (limitPrice.lessThanOrEqualTo(0)) {
        errors.push("Harga limit harus positif");
      } else if (!isTickAligned(limitPrice, spec.priceTick)) {
        errors.push(`Harga harus kelipatan tick ${spec.priceTick}`);
      }
    }
  }

  // ── Kutipan pasar ─────────────────────────────────────────────
  const bestBid = input.market.bestBid === null ? null : dec(input.market.bestBid);
  const bestAsk = input.market.bestAsk === null ? null : dec(input.market.bestAsk);

  let referencePrice: Decimal | null = null;
  if (input.type === "market") {
    // BUY/LONG mengeksekusi di ASK, SELL/SHORT di BID.
    referencePrice = input.side === "buy" ? bestAsk : bestBid;
    if (referencePrice === null) {
      errors.push("Kutipan pasar belum tersedia — tidak ada harga eksekusi");
    }
  } else {
    referencePrice = limitPrice;
  }

  // ── Marketability (preview saja; matching backend tetap otoritatif) ──
  let marketable = false;
  if (input.type === "limit" && limitPrice !== null) {
    if (input.side === "buy") {
      marketable = bestAsk !== null && limitPrice.greaterThanOrEqualTo(bestAsk);
    } else {
      marketable = bestBid !== null && limitPrice.lessThanOrEqualTo(bestBid);
    }
    if (!marketable) {
      warnings.push("RESTING — margin akan direservasi sampai order terisi atau dibatalkan");
    } else {
      warnings.push("MARKETABLE — dapat tereksekusi segera sebagai taker");
    }
  }

  const liquidity: "maker" | "taker" | null =
    input.type === "market" ? "taker" : marketable ? "taker" : "maker";

  // ── TP/SL: semantik arah (mengikuti aturan backend) ───────────
  if (input.takeProfitPrice !== null && isDecimal(input.takeProfitPrice)) {
    const tp = dec(input.takeProfitPrice);
    if (!isTickAligned(tp, spec.priceTick)) {
      errors.push(`Take profit harus kelipatan tick ${spec.priceTick}`);
    }
    if (referencePrice !== null) {
      if (input.side === "buy" && tp.lessThanOrEqualTo(referencePrice)) {
        errors.push("Take profit LONG harus di atas harga referensi");
      }
      if (input.side === "sell" && tp.greaterThanOrEqualTo(referencePrice)) {
        errors.push("Take profit SHORT harus di bawah harga referensi");
      }
    }
  } else if (input.takeProfitPrice !== null) {
    errors.push("Take profit harus berupa angka desimal");
  }

  if (input.stopLossPrice !== null && isDecimal(input.stopLossPrice)) {
    const sl = dec(input.stopLossPrice);
    if (!isTickAligned(sl, spec.priceTick)) {
      errors.push(`Stop loss harus kelipatan tick ${spec.priceTick}`);
    }
    if (referencePrice !== null) {
      if (input.side === "buy" && sl.greaterThanOrEqualTo(referencePrice)) {
        errors.push("Stop loss LONG harus di bawah harga referensi");
      }
      if (input.side === "sell" && sl.lessThanOrEqualTo(referencePrice)) {
        errors.push("Stop loss SHORT harus di atas harga referensi");
      }
    }
  } else if (input.stopLossPrice !== null) {
    errors.push("Stop loss harus berupa angka desimal");
  }

  // ── Estimasi ekonomi ──────────────────────────────────────────
  let baseQuantity: Decimal | null = null;
  let notional: Decimal | null = null;
  let estimatedMargin: Decimal | null = null;
  let estimatedFee: Decimal | null = null;
  let estimatedReservation: Decimal | null = null;

  if (size !== null && referencePrice !== null) {
    const multiplier = dec(spec.quantoMultiplier);
    baseQuantity = size.times(multiplier);
    notional = baseQuantity.times(referencePrice);
    if (leverage !== null && leverage.greaterThan(0)) {
      estimatedMargin = roundUpMoney(notional.dividedBy(leverage));
    }
    const feeRate = dec(liquidity === "maker" ? spec.makerFeeRate : spec.takerFeeRate);
    // Fee bertanda: rebate maker tetap negatif dan tetap terlihat di preview.
    estimatedFee = notional.times(feeRate).toDecimalPlaces(8, Decimal.ROUND_CEIL);
    if (input.type === "limit" && !marketable) {
      estimatedReservation = estimatedMargin;
    }
  }

  // ── Likuiditas yang diketahui (puncak buku saja) ──────────────
  let knownExecutableSize: number | null = null;
  let insufficientKnownLiquidity = false;
  if (input.type === "market") {
    knownExecutableSize = input.side === "buy" ? input.market.bestAskSize : input.market.bestBidSize;
    if (size !== null && knownExecutableSize !== null && input.market.bestAskSize !== null) {
      // Hanya puncak buku yang diketahui: jangan mengklaim seluruh order terisi.
      insufficientKnownLiquidity = size.greaterThan(knownExecutableSize);
      if (insufficientKnownLiquidity) {
        warnings.push(
          `Liquidity di puncak buku hanya ${knownExecutableSize} kontrak — order dapat terisi sebagian`,
        );
      }
    } else if (knownExecutableSize === null) {
      warnings.push("Ukuran likuiditas puncak buku tidak diketahui — estimasi terbatas");
    }
  }

  // ── Kecukupan saldo ───────────────────────────────────────────
  let insufficientBalance = false;
  if (estimatedMargin !== null && input.availableBalance !== null && isDecimal(input.availableBalance)) {
    const required = estimatedMargin.plus(estimatedFee !== null && estimatedFee.greaterThan(0) ? estimatedFee : ZERO);
    if (required.greaterThan(dec(input.availableBalance))) {
      insufficientBalance = true;
      errors.push("Saldo virtual tidak cukup untuk margin + fee yang diperkirakan");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    marketable,
    liquidity,
    referencePrice: referencePrice === null ? null : referencePrice.toString(),
    estimatedEntry: referencePrice === null ? null : referencePrice.toString(),
    baseQuantity: baseQuantity === null ? null : baseQuantity.toString(),
    notional: notional === null ? null : notional.toString(),
    // Margin/fee/reservasi adalah besaran UANG: keluarkan sebagai string 8 dp
    // kanonik agar sebanding dengan nilai ledger dari backend.
    estimatedMargin: estimatedMargin === null ? null : estimatedMargin.toFixed(8),
    estimatedFee: estimatedFee === null ? null : estimatedFee.toFixed(8),
    estimatedReservation: estimatedReservation === null ? null : estimatedReservation.toFixed(8),
    knownExecutableSize,
    insufficientKnownLiquidity,
    insufficientBalance,
  };
}

function emptyPreview(errors: string[], warnings: string[]): OrderPreview {
  return {
    valid: false,
    errors,
    warnings,
    marketable: false,
    liquidity: null,
    referencePrice: null,
    estimatedEntry: null,
    baseQuantity: null,
    notional: null,
    estimatedMargin: null,
    estimatedFee: null,
    estimatedReservation: null,
    knownExecutableSize: null,
    insufficientKnownLiquidity: false,
    insufficientBalance: false,
  };
}

/** Apakah limit akan langsung tereksekusi (preview; batas kesetaraan inklusif). */
export function isMarketable(
  side: TicketSide,
  limitPrice: string,
  quote: { bestBid: string | null; bestAsk: string | null },
): boolean {
  if (!isDecimal(limitPrice)) {
    return false;
  }
  const limit = dec(limitPrice);
  if (side === "buy") {
    return quote.bestAsk !== null && limit.greaterThanOrEqualTo(quote.bestAsk);
  }
  return quote.bestBid !== null && limit.lessThanOrEqualTo(quote.bestBid);
}

/** Batasi leverage ke rentang kontrak tanpa membulatkan diam-diam. */
export function clampLeverage(spec: ContractDto | null, leverage: string): string {
  if (spec === null || !isDecimal(leverage)) {
    return leverage;
  }
  const value = dec(leverage);
  const min = dec(spec.leverageMin);
  const max = dec(spec.leverageMax);
  if (value.lessThan(min)) {
    return spec.leverageMin;
  }
  if (value.greaterThan(max)) {
    return spec.leverageMax;
  }
  return value.toString();
}
