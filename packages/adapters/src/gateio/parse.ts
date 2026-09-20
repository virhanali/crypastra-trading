import {
  ContractSpecSchema,
  Decimal,
  type BookLevel,
  type BookSnapshot,
  type BookUpdate,
  type Candle,
  type ContractSpec,
  type BookTickerTick,
  type Ticker,
  type Trade,
} from "@crypastra/core";

/**
 * Fungsi parse murni untuk payload Gate.io. Dipisah dari provider supaya:
 *  - bisa diuji tanpa WebSocket (regresi bug parsing),
 *  - batas I/O tetap tipis dan provider hanya mengurus koneksi.
 *
 * Semua fakta bentuk payload diverifikasi di docs/gateio-market-data.md.
 */

export interface GateContractPayload {
  name: string;
  quanto_multiplier: string;
  order_size_min: number;
  order_size_max: number;
  enable_decimal?: boolean;
  order_price_round: string;
  mark_price_round: string;
  leverage_min: string;
  leverage_max: string;
  maintenance_rate: string;
  maker_fee_rate: string;
  taker_fee_rate: string;
  funding_interval: number;
  market_order_slip_ratio?: string;
  status: string;
}

export interface GateCandlePayload {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: number;
  sum?: string;
  w?: boolean;
  n?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = "0"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const INTERVAL_PATTERN = /^\d+[mhd]$/;

/** `n` = "<interval>_<contract>"; kontrak sendiri mengandung "_". */
export function splitCandleName(name: string): { interval: string; contract: string } | null {
  const separator = name.indexOf("_");
  if (separator <= 0 || separator === name.length - 1) {
    return null;
  }
  const interval = name.slice(0, separator);
  const contract = name.slice(separator + 1);
  // Tolak nama tanpa interval valid (mis. "BTC_USDT") daripada menghasilkan
  // interval sampah "BTC".
  if (!INTERVAL_PATTERN.test(interval)) {
    return null;
  }
  return { interval, contract };
}

export function toTicker(raw: Record<string, unknown>, fallbackTsMs: number): Ticker | null {
  const contract = asString(raw.contract, "");
  if (contract === "") {
    return null;
  }
  return {
    contract,
    lastPrice: asString(raw.last),
    // Mark bisa absen pada snapshot parsial; jangan diam-diam pakai angka karangan.
    markPrice: asString(raw.mark_price, asString(raw.last)),
    indexPrice: asString(raw.index_price, asString(raw.mark_price, asString(raw.last))),
    // Absen berarti null — bukan "0" (jangan mengarang nilai finansial).
    fundingRate: raw.funding_rate === undefined ? null : asString(raw.funding_rate),
    fundingRateIndicative:
      raw.funding_rate_indicative === undefined
        ? raw.funding_rate === undefined
          ? null
          : asString(raw.funding_rate)
        : asString(raw.funding_rate_indicative),
    fundingNextApplySeconds: asNumber(raw.funding_next_apply),
    fundingIntervalSeconds: asNumber(raw.funding_interval),
    eventTsMs: asNumber(raw.t) ?? fallbackTsMs,
  };
}

export function toCandles(result: unknown): Candle[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const candles: Candle[] = [];
  for (const item of result) {
    const raw = asRecord(item) as GateCandlePayload | null;
    if (raw === null || typeof raw.t !== "number") {
      continue;
    }
    const split = splitCandleName(asString(raw.n, ""));
    if (split === null) {
      continue;
    }
    candles.push({
      contract: split.contract,
      interval: split.interval,
      openTimeSeconds: raw.t,
      o: raw.o,
      h: raw.h,
      l: raw.l,
      c: raw.c,
      v: raw.v,
      // `w` = window SUDAH tertutup. Diverifikasi empiris: w=false saat window
      // masih berjalan, w=true tepat setelah window berakhir (probe 1m candle).
      sum: raw.sum ?? "0",
      windowClosed: raw.w === true,
    });
  }
  return candles;
}

export function toTrades(result: unknown, fallbackTsMs: number): Trade[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const trades: Trade[] = [];
  for (const item of result) {
    const raw = asRecord(item);
    if (raw === null) {
      continue;
    }
    const signedSize = asNumber(raw.size) ?? 0;
    trades.push({
      contract: asString(raw.contract, ""),
      id: asString(raw.id, ""),
      price: asString(raw.price),
      // `size` bertanda: negatif = taker sell. Tanda dipindah ke takerSide
      // supaya ukuran tetap absolut dan arah tidak hilang.
      size: Math.abs(signedSize),
      takerSide: signedSize < 0 ? "sell" : "buy",
      eventTsMs: asNumber(raw.create_time_ms) ?? fallbackTsMs,
    });
  }
  return trades;
}

/** `futures.book_ticker` → best bid/ask. Sisi yang hilang tetap null. */
export function toBookTicker(raw: Record<string, unknown>, fallbackTsMs: number): BookTickerTick | null {
  const contract = asString(raw.s, asString(raw.contract, ""));
  if (contract === "") {
    return null;
  }
  const bestBid = raw.b === undefined ? null : asString(raw.b);
  const bestAsk = raw.a === undefined ? null : asString(raw.a);
  return {
    contract,
    bestBid,
    bestBidSize: asNumber(raw.B),
    bestAsk,
    bestAskSize: asNumber(raw.A),
    updateId: asNumber(raw.u),
    eventTsMs: asNumber(raw.t) ?? fallbackTsMs,
  };
}

export function toBookLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const raw = asRecord(item);
    if (raw === null) {
      return [];
    }
    const price = raw.p;
    const size = asNumber(raw.s);
    if (price === undefined || size === null) {
      return [];
    }
    return [{ price: new Decimal(String(price)).toFixed(), size }];
  });
}

export function toBookUpdate(result: unknown, fallbackTsMs: number): BookUpdate | null {
  const raw = asRecord(result);
  if (raw === null) {
    return null;
  }
  return {
    contract: asString(raw.s, ""),
    firstUpdateId: asNumber(raw.U) ?? 0,
    lastUpdateId: asNumber(raw.u) ?? 0,
    eventTsMs: asNumber(raw.t) ?? fallbackTsMs,
    bids: toBookLevels(raw.b),
    asks: toBookLevels(raw.a),
  };
}

export function toBookSnapshot(result: unknown, fallbackTsMs: number): BookSnapshot | null {
  const raw = asRecord(result);
  if (raw === null) {
    return null;
  }
  return {
    contract: asString(raw.s, asString(raw.contract, "")),
    updateId: asNumber(raw.u) ?? 0,
    eventTsMs: asNumber(raw.t) ?? fallbackTsMs,
    bids: toBookLevels(raw.bids ?? raw.b),
    asks: toBookLevels(raw.asks ?? raw.a),
  };
}

export function toContractSpec(payload: GateContractPayload, requested: string): ContractSpec {
  const separator = requested.indexOf("_");
  const base = separator > 0 ? requested.slice(0, separator) : requested;
  const quote = separator > 0 ? requested.slice(separator + 1) : "USDT";
  return ContractSpecSchema.parse({
    contract: payload.name,
    base,
    quote,
    quantoMultiplier: payload.quanto_multiplier,
    orderSizeMin: payload.order_size_min,
    orderSizeMax: payload.order_size_max,
    // 14 dari 997 kontrak USDT bernilai true (termasuk ETH_USDT, SOL_USDT,
    // XRP_USDT, TRX_USDT) dan punya order_size_min = 0.
    enableDecimal: payload.enable_decimal === true,
    orderPriceRound: payload.order_price_round,
    markPriceRound: payload.mark_price_round,
    leverageMin: payload.leverage_min,
    leverageMax: payload.leverage_max,
    maintenanceRate: payload.maintenance_rate,
    makerFeeRate: payload.maker_fee_rate,
    takerFeeRate: payload.taker_fee_rate,
    fundingIntervalSeconds: payload.funding_interval,
    marketOrderSlipRatio: payload.market_order_slip_ratio ?? null,
    status: payload.status,
    source: "gateio",
  });
}

export function intervalToSeconds(interval: string): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (match === null) {
    throw new Error(`Interval tidak dikenal: ${interval}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return amount * factor;
}