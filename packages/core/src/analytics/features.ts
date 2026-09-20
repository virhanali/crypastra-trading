import { Decimal } from "../money.js";
import type { Candle } from "../market.js";

/**
 * Feature Engine deterministik (Phase 9).
 *
 * MURNI: tanpa DB, repository, service ekonomi, HTTP, `Date.now()`, atau
 * `Math.random()`. Input hanya candle TERTUTUP + konfigurasi; output hanya
 * FeatureSnapshot. Operasi hanya pada candle yang sudah tertutup — tidak ada
 * intrabar dan tidak ada look-ahead.
 *
 * PRESISI: indikator adalah desimal ANALITIK, bukan uang ledger. Nilai tidak
 * dibulatkan ke 8 dp; `Decimal` (presisi 40) dipakai apa adanya dan disimpan
 * sebagai string eksak. Pembulatan hanya untuk tampilan.
 *
 * Definisi indikator (eksak, lihat docs/FEATURES.md):
 *  - EMA(p)   : seed = SMA(p) dari p close pertama, lalu alpha = 2/(p+1)
 *  - RSI(14)  : Wilder. Seed avgGain/avgLoss = SMA(14) dari perubahan pertama;
 *               selanjutnya avg = (avg*(13) + x)/14.
 *               avgLoss == 0 dan avgGain == 0 → 50 (pasar datar, netral);
 *               avgLoss == 0 dan avgGain > 0 → 100.
 *  - ATR(14)  : TR = max(h-l, |h-prevClose|, |l-prevClose|) (candle pertama:
 *               h-l). Seed = SMA(14) TR pertama; lalu Wilder (13+1)/14.
 *  - MACD     : EMA12 - EMA26; signal = EMA9 dari deret MACD itu.
 *  - Return_n : (close_t - close_{t-n}) / close_{t-n}   (return aritmetik)
 *  - Volume   : volumeRatio = v / SMA20(v)
 *  - Distance : (close - EMA) / EMA
 */

export const FEATURE_VERSION = "features-v1";
export const FEATURE_TIMEFRAME = "5m";

/** Parameter indikator V1. Jangan ditambah tanpa alasan yang terdokumentasi. */
export interface FeatureConfig {
  readonly timeframe: string;
  readonly emaPeriods: readonly number[];
  readonly rsiPeriod: number;
  readonly atrPeriod: number;
  readonly macdFast: number;
  readonly macdSlow: number;
  readonly macdSignal: number;
  readonly returnLookbacks: readonly number[];
  readonly volumePeriod: number;
  readonly requiredEmaPeriod: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  timeframe: FEATURE_TIMEFRAME,
  emaPeriods: [20, 50, 200],
  rsiPeriod: 14,
  atrPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  returnLookbacks: [1, 3, 12],
  volumePeriod: 20,
  requiredEmaPeriod: 200,
};

export type TrendStructure = "bullish" | "bearish" | "mixed";

export interface FeatureSnapshot {
  readonly contract: string;
  readonly timeframe: string;
  readonly featureVersion: string;
  /** Waktu tutup candle (epoch ms, EKSKLUSIF batas look-ahead). */
  readonly candleCloseTimeMs: number;
  readonly candleOpenTimeMs: number;
  /** Jumlah candle tertutup yang sudah diproses untuk kontrak ini. */
  readonly candleCount: number;

  /** Indikator; null bila belum tersedia (warmup). */
  readonly close: string;
  readonly ema20: string | null;
  readonly ema50: string | null;
  readonly ema200: string | null;
  readonly rsi14: string | null;
  readonly macd: string | null;
  readonly macdSignal: string | null;
  readonly macdHistogram: string | null;
  readonly atr14: string | null;
  readonly atrPercent: string | null;
  readonly return1: string | null;
  readonly return3: string | null;
  readonly return12: string | null;
  readonly volume: number;
  readonly volumeMa20: string | null;
  readonly volumeRatio: string | null;
  readonly distanceEma20Pct: string | null;
  readonly distanceEma50Pct: string | null;
  readonly distanceEma200Pct: string | null;

  readonly trendStructure: TrendStructure | null;
  readonly facts: {
    readonly aboveEma20: boolean | null;
    readonly aboveEma50: boolean | null;
    readonly aboveEma200: boolean | null;
    readonly emaStackedBullish: boolean | null;
    readonly emaStackedBearish: boolean | null;
    readonly macdAboveSignal: boolean | null;
    readonly macdHistogramPositive: boolean | null;
    readonly rsiOverbought: boolean | null;
    readonly rsiOversold: boolean | null;
  };

  /** true bila seluruh fitur yang diwajibkan sudah tersedia. */
  readonly warmupComplete: boolean;
  /** Berapa candle lagi minimal sampai warmup selesai (0 bila selesai). */
  readonly warmupRemaining: number;
}

/** Keadaan internal engine: rekursif, sehingga hasil tidak bergantung panjang riwayat. */
export interface EngineState {
  readonly contract: string;
  readonly timeframe: string;
  candleCount: number;
  lastOpenTimeSeconds: number | null;
  /** 13 close terakhir untuk return 12. */
  recentCloses: Decimal[];
  /** Window volume untuk SMA20. */
  recentVolumes: number[];
  readonly ema: Map<number, { value: Decimal | null; seedSum: Decimal; seedCount: number }>;
  rsiAvgGain: Decimal | null;
  rsiAvgLoss: Decimal | null;
  rsiSeedGain: Decimal;
  rsiSeedLoss: Decimal;
  rsiSeedCount: number;
  prevClose: Decimal | null;
  atr: Decimal | null;
  atrSeedSum: Decimal;
  atrSeedCount: number;
  macdFast: Decimal | null;
  macdSlow: Decimal | null;
  macd: Decimal | null;
  macdSignalValue: Decimal | null;
  macdSignalSeedSum: Decimal;
  macdSignalSeedCount: number;
}

export function createEngineState(
  contract: string,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): EngineState {
  const ema = new Map<number, { value: Decimal | null; seedSum: Decimal; seedCount: number }>();
  // EMA MACD (12/26) adalah INTERNAL MACD, bukan indikator terbit tersendiri:
  // EMA 20/50/200 tetap satu-satunya EMA yang diekspos di FeatureSnapshot.
  const periods = new Set<number>([...config.emaPeriods, config.macdFast, config.macdSlow]);
  for (const period of periods) {
    ema.set(period, { value: null, seedSum: new Decimal(0), seedCount: 0 });
  }
  return {
    contract,
    timeframe: config.timeframe,
    candleCount: 0,
    lastOpenTimeSeconds: null,
    recentCloses: [],
    recentVolumes: [],
    ema,
    rsiAvgGain: null,
    rsiAvgLoss: null,
    rsiSeedGain: new Decimal(0),
    rsiSeedLoss: new Decimal(0),
    rsiSeedCount: 0,
    prevClose: null,
    atr: null,
    atrSeedSum: new Decimal(0),
    atrSeedCount: 0,
    macdFast: null,
    macdSlow: null,
    macd: null,
    macdSignalValue: null,
    macdSignalSeedSum: new Decimal(0),
    macdSignalSeedCount: 0,
  };
}

export type ApplyOutcome =
  | { readonly status: "applied"; readonly snapshot: FeatureSnapshot }
  | { readonly status: "duplicate" }
  | { readonly status: "out_of_order"; readonly lastOpenTimeSeconds: number }
  | { readonly status: "not_closed" }
  | { readonly status: "wrong_interval"; readonly expected: string }
  | { readonly status: "wrong_contract"; readonly expected: string };

/**
 * Terapkan satu candle ke keadaan. Hanya candle TERTUTUP yang diterima.
 *
 * Candle duplikat (open time sama dengan yang terakhir) diabaikan tanpa
 * mengubah keadaan. Candle yang lebih lama ditolak sebagai out-of-order —
 * keadaan tidak pernah rusak diam-diam.
 */
export function applyClosedCandle(
  state: EngineState,
  candle: Candle,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): ApplyOutcome {
  if (candle.contract !== state.contract) {
    return { status: "wrong_contract", expected: state.contract };
  }
  if (candle.interval !== state.timeframe) {
    return { status: "wrong_interval", expected: state.timeframe };
  }
  if (!candle.windowClosed) {
    return { status: "not_closed" };
  }
  if (state.lastOpenTimeSeconds !== null && candle.openTimeSeconds === state.lastOpenTimeSeconds) {
    return { status: "duplicate" };
  }
  if (state.lastOpenTimeSeconds !== null && candle.openTimeSeconds < state.lastOpenTimeSeconds) {
    return { status: "out_of_order", lastOpenTimeSeconds: state.lastOpenTimeSeconds };
  }

  const close = new Decimal(candle.c);
  const high = new Decimal(candle.h);
  const low = new Decimal(candle.l);
  const volume = candle.v;

  // ── EMA (seed SMA lalu recursif) ──────────────────────────────
  for (const [period, slot] of state.ema) {
    if (slot.value === null) {
      slot.seedSum = slot.seedSum.plus(close);
      slot.seedCount += 1;
      if (slot.seedCount === period) {
        slot.value = slot.seedSum.dividedBy(period);
      }
    } else {
      const alpha = new Decimal(2).dividedBy(period + 1);
      slot.value = alpha.times(close).plus(new Decimal(1).minus(alpha).times(slot.value));
    }
  }

  // ── RSI Wilder ────────────────────────────────────────────────
  if (state.prevClose !== null) {
    const change = close.minus(state.prevClose);
    const gain = change.isNegative() ? new Decimal(0) : change;
    const loss = change.isNegative() ? change.negated() : new Decimal(0);
    if (state.rsiAvgGain === null) {
      state.rsiSeedGain = state.rsiSeedGain.plus(gain);
      state.rsiSeedLoss = state.rsiSeedLoss.plus(loss);
      state.rsiSeedCount += 1;
      if (state.rsiSeedCount === config.rsiPeriod) {
        state.rsiAvgGain = state.rsiSeedGain.dividedBy(config.rsiPeriod);
        state.rsiAvgLoss = state.rsiSeedLoss.dividedBy(config.rsiPeriod);
      }
    } else {
      state.rsiAvgGain = state.rsiAvgGain
        .times(config.rsiPeriod - 1)
        .plus(gain)
        .dividedBy(config.rsiPeriod);
      state.rsiAvgLoss = (state.rsiAvgLoss ?? new Decimal(0))
        .times(config.rsiPeriod - 1)
        .plus(loss)
        .dividedBy(config.rsiPeriod);
    }
  }

  // ── ATR Wilder ────────────────────────────────────────────────
  const trueRange =
    state.prevClose === null
      ? high.minus(low)
      : Decimal.max(
          high.minus(low),
          high.minus(state.prevClose).abs(),
          low.minus(state.prevClose).abs(),
        );
  if (state.atr === null) {
    state.atrSeedSum = state.atrSeedSum.plus(trueRange);
    state.atrSeedCount += 1;
    if (state.atrSeedCount === config.atrPeriod) {
      state.atr = state.atrSeedSum.dividedBy(config.atrPeriod);
    }
  } else {
    state.atr = state.atr
      .times(config.atrPeriod - 1)
      .plus(trueRange)
      .dividedBy(config.atrPeriod);
  }

  // ── MACD ──────────────────────────────────────────────────────
  const fastSlot = state.ema.get(config.macdFast);
  const slowSlot = state.ema.get(config.macdSlow);
  const fast = fastSlot?.value ?? null;
  const slow = slowSlot?.value ?? null;
  if (fast !== null && slow !== null) {
    state.macd = fast.minus(slow);
    if (state.macdSignalValue === null) {
      state.macdSignalSeedSum = state.macdSignalSeedSum.plus(state.macd);
      state.macdSignalSeedCount += 1;
      if (state.macdSignalSeedCount === config.macdSignal) {
        state.macdSignalValue = state.macdSignalSeedSum.dividedBy(config.macdSignal);
      }
    } else {
      const alpha = new Decimal(2).dividedBy(config.macdSignal + 1);
      state.macdSignalValue = alpha
        .times(state.macd)
        .plus(new Decimal(1).minus(alpha).times(state.macdSignalValue));
    }
  }

  // ── Riwayat ringkas ───────────────────────────────────────────
  state.recentCloses.push(close);
  const maxCloses = Math.max(...config.returnLookbacks) + 1;
  if (state.recentCloses.length > maxCloses) {
    state.recentCloses.splice(0, state.recentCloses.length - maxCloses);
  }
  state.recentVolumes.push(volume);
  if (state.recentVolumes.length > config.volumePeriod) {
    state.recentVolumes.splice(0, state.recentVolumes.length - config.volumePeriod);
  }

  state.prevClose = close;
  state.candleCount += 1;
  state.lastOpenTimeSeconds = candle.openTimeSeconds;

  return { status: "applied", snapshot: snapshotFrom(state, candle, config) };
}

/** Bangun FeatureSnapshot dari keadaan saat ini. */
export function snapshotFrom(
  state: EngineState,
  candle: Pick<Candle, "contract" | "interval" | "openTimeSeconds" | "c" | "v">,
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): FeatureSnapshot {
  const close = new Decimal(candle.c);
  const ema = (period: number): Decimal | null => state.ema.get(period)?.value ?? null;

  const ema20 = ema(20);
  const ema50 = ema(50);
  const ema200 = ema(200);

  const rsi = computeRsi(state);
  const macd = state.macd;
  const macdSignal = state.macdSignalValue;
  const histogram =
    macd !== null && macdSignal !== null ? macd.minus(macdSignal) : null;
  const atr = state.atr;
  const atrPercent = atr === null ? null : atr.dividedBy(close).times(100);

  const volumeMa20 = smaOf(state.recentVolumes, config.volumePeriod);
  const volumeRatio =
    volumeMa20 === null || volumeMa20.isZero()
      ? null
      : new Decimal(candle.v).dividedBy(volumeMa20);

  const distance = (value: Decimal | null): Decimal | null =>
    value === null || value.isZero() ? null : close.minus(value).dividedBy(value).times(100);

  const trendStructure = trendOf(ema20, ema50, ema200);

  const warmupComplete =
    ema20 !== null &&
    ema50 !== null &&
    ema200 !== null &&
    rsi !== null &&
    macd !== null &&
    macdSignal !== null &&
    atr !== null &&
    volumeMa20 !== null &&
    distance(ema20) !== null &&
    returnOf(state, 1) !== null &&
    returnOf(state, 3) !== null &&
    returnOf(state, 12) !== null;

  const warmupRemaining = warmupComplete
    ? 0
    : Math.max(0, config.requiredEmaPeriod - state.candleCount);

  return {
    contract: state.contract,
    timeframe: config.timeframe,
    featureVersion: FEATURE_VERSION,
    candleOpenTimeMs: candle.openTimeSeconds * 1000,
    candleCloseTimeMs: candle.openTimeSeconds * 1000 + timeframeMs(config.timeframe),
    candleCount: state.candleCount,
    close: close.toString(),
    ema20: ema20?.toString() ?? null,
    ema50: ema50?.toString() ?? null,
    ema200: ema200?.toString() ?? null,
    rsi14: rsi?.toString() ?? null,
    macd: macd?.toString() ?? null,
    macdSignal: macdSignal?.toString() ?? null,
    macdHistogram: histogram?.toString() ?? null,
    atr14: atr?.toString() ?? null,
    atrPercent: atrPercent?.toString() ?? null,
    return1: returnOf(state, 1)?.toString() ?? null,
    return3: returnOf(state, 3)?.toString() ?? null,
    return12: returnOf(state, 12)?.toString() ?? null,
    volume: candle.v,
    volumeMa20: volumeMa20?.toString() ?? null,
    volumeRatio: volumeRatio?.toString() ?? null,
    distanceEma20Pct: distance(ema20)?.toString() ?? null,
    distanceEma50Pct: distance(ema50)?.toString() ?? null,
    distanceEma200Pct: distance(ema200)?.toString() ?? null,
    trendStructure,
    facts: {
      aboveEma20: ema20 === null ? null : close.greaterThan(ema20),
      aboveEma50: ema50 === null ? null : close.greaterThan(ema50),
      aboveEma200: ema200 === null ? null : close.greaterThan(ema200),
      emaStackedBullish: ema20 !== null && ema50 !== null && ema200 !== null ? ema20.greaterThan(ema50) && ema50.greaterThan(ema200) : null,
      emaStackedBearish: ema20 !== null && ema50 !== null && ema200 !== null ? ema20.lessThan(ema50) && ema50.lessThan(ema200) : null,
      macdAboveSignal: histogram === null ? null : histogram.isPositive(),
      macdHistogramPositive: histogram === null ? null : histogram.greaterThan(0),
      rsiOverbought: rsi === null ? null : rsi.greaterThan(70),
      rsiOversold: rsi === null ? null : rsi.lessThan(30),
    },
    warmupComplete,
    warmupRemaining,
  };
}

/** Return aritmetik: (close_t − close_{t−n}) / close_{t−n}. */
export function returnOf(state: EngineState, lookback: number): Decimal | null {
  const closes = state.recentCloses;
  if (closes.length < lookback + 1) {
    return null;
  }
  const current = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - lookback]!;
  if (past.isZero()) {
    return null;
  }
  return current.minus(past).dividedBy(past);
}

/**
 * RSI Wilder. Pasar datar (avgGain == 0 dan avgLoss == 0) didefinisikan
 * NETRAL = 50, bukan 100 — 100 akan menyatakan overbought di pasar yang tidak
 * bergerak sama sekali.
 */
export function computeRsi(state: EngineState): Decimal | null {
  if (state.rsiAvgGain === null || state.rsiAvgLoss === null) {
    return null;
  }
  if (state.rsiAvgLoss.isZero()) {
    if (state.rsiAvgGain.isZero()) {
      return new Decimal(50);
    }
    return new Decimal(100);
  }
  const rs = state.rsiAvgGain.dividedBy(state.rsiAvgLoss);
  return new Decimal(100).minus(new Decimal(100).dividedBy(rs.plus(1)));
}

export function smaOf(values: readonly number[], period: number): Decimal | null {
  if (values.length < period) {
    return null;
  }
  return values
    .slice(values.length - period)
    .reduce((sum, value) => sum.plus(value), new Decimal(0))
    .dividedBy(period);
}

export function trendOf(
  ema20: Decimal | null,
  ema50: Decimal | null,
  ema200: Decimal | null,
): TrendStructure | null {
  if (ema20 === null || ema50 === null || ema200 === null) {
    return null;
  }
  if (ema20.greaterThan(ema50) && ema50.greaterThan(ema200)) {
    return "bullish";
  }
  if (ema20.lessThan(ema50) && ema50.lessThan(ema200)) {
    return "bearish";
  }
  return "mixed";
}

export function timeframeMs(timeframe: string): number {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (match === null) {
    throw new Error(`Timeframe tidak dikenal: ${timeframe}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

/**
 * Orakel BATCH: hitung ulang dari nol untuk seluruh deret candle.
 *
 * Dipakai test untuk membuktikan engine inkremental menghasilkan nilai yang
 * SAMA. Ini implementasi referensi, bukan jalur produksi.
 */
export function computeFeaturesBatch(
  contract: string,
  candles: readonly Candle[],
  config: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): FeatureSnapshot | null {
  const state = createEngineState(contract, config);
  let last: FeatureSnapshot | null = null;
  for (const candle of candles) {
    const outcome = applyClosedCandle(state, candle, config);
    if (outcome.status === "applied") {
      last = outcome.snapshot;
    }
  }
  return last;
}
