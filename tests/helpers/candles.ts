import { Decimal, type Candle } from "@crypastra/core";

/**
 * Fixture candle sintetis DETERMINISTIK (Phase 9).
 *
 * Tidak memakai `Math.random()` atau waktu dinding: seluruh nilai adalah
 * fungsi murni dari indeks candle. Regime disusun eksplisit supaya scanner
 * menghadapi: datar, uptrend, ekspansi volatilitas, downtrend, dan lonjakan
 * volume — tanpa perlu data pasar nyata.
 */
export const FIXTURE_TIMEFRAME = "5m";
export const FIXTURE_INTERVAL_SECONDS = 300;
export const FIXTURE_START_SECONDS = 1_700_000_000;

export type Regime = "flat" | "uptrend" | "volatility_expansion" | "downtrend" | "volume_spike";

/** Segmentasi regime fixture (indeks inklusif-eksklusif). */
export const FIXTURE_REGIMES: readonly { regime: Regime; from: number; to: number }[] = [
  { regime: "flat", from: 0, to: 50 },
  { regime: "uptrend", from: 50, to: 120 },
  { regime: "volatility_expansion", from: 120, to: 170 },
  { regime: "downtrend", from: 170, to: 220 },
  { regime: "volume_spike", from: 220, to: 280 },
];

export function regimeAt(index: number): Regime {
  for (const segment of FIXTURE_REGIMES) {
    if (index >= segment.from && index < segment.to) {
      return segment.regime;
    }
  }
  return "volume_spike";
}

function closeFor(index: number): Decimal {
  if (index === 0) {
    return new Decimal("100.0");
  }
  const previous = closeFor(index - 1);
  const regime = regimeAt(index - 1);
  switch (regime) {
    case "flat":
      // Variasi kecil deterministik naik-turun, tanpa tren.
      return previous.times(index % 2 === 0 ? "1.0005" : "0.9995");
    case "uptrend":
      return previous.times("1.003");
    case "volatility_expansion":
      // Amplitudo membesar karena faktor bergantung indeks, bukan acak.
      return previous.times(index % 2 === 0 ? "1.02" : "0.975");
    case "downtrend":
      return previous.times("0.996");
    case "volume_spike":
      return previous.times("1.001");
  }
}

function volumeFor(index: number): number {
  const regime = regimeAt(index);
  if (regime === "volume_spike") {
    return 500 + (index % 5);
  }
  if (regime === "volatility_expansion") {
    return 180 + (index % 7);
  }
  return 100 + (index % 3);
}

export function syntheticCandle(contract: string, index: number): Candle {
  const close = closeFor(index);
  const regime = regimeAt(index);
  const spread = regime === "volatility_expansion" ? "0.012" : regime === "uptrend" ? "0.004" : "0.006";
  const high = close.times(new Decimal(1).plus(spread));
  const low = close.times(new Decimal(1).minus(spread));
  const open = index === 0 ? new Decimal("100.0") : closeFor(index - 1);
  const volume = volumeFor(index);
  return {
    contract,
    interval: FIXTURE_TIMEFRAME,
    openTimeSeconds: FIXTURE_START_SECONDS + index * FIXTURE_INTERVAL_SECONDS,
    o: open.toString(),
    h: Decimal.max(high, open, close).toString(),
    l: Decimal.min(low, open, close).toString(),
    c: close.toString(),
    v: volume,
    sum: close.times(volume).toString(),
    windowClosed: true,
  };
}

/** Deret candle tertutup; default 280 candle (melewati warmup EMA200). */
export function syntheticCandles(contract: string, count = 280): Candle[] {
  return Array.from({ length: count }, (_, index) => syntheticCandle(contract, index));
}

/** Candle dengan close konstan — untuk uji EMA/ATR/RSI pasar datar. */
export function constantCandles(contract: string, count: number, price = "100"): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    contract,
    interval: FIXTURE_TIMEFRAME,
    openTimeSeconds: FIXTURE_START_SECONDS + index * FIXTURE_INTERVAL_SECONDS,
    o: price,
    h: price,
    l: price,
    c: price,
    v: 100,
    sum: new Decimal(price).times(100).toString(),
    windowClosed: true,
  }));
}

/**
 * Deret "setup bullish": tren naik landai dengan pullback berkala, sehingga
 * RSI berakhir di rentang 50-70 (bukan jenuh), EMA bertumpuk bullish, MACD
 * histogram positif, jarak dari EMA20 di bawah ambang overextended, dan
 * volume 20 candle terakhir naik.
 */
function setupCandles(contract: string, direction: "bull" | "bear", count: number): Candle[] {
  const up = direction === "bull";
  const step = up ? new Decimal("1.0015") : new Decimal("0.9985");
  const pullback = up ? new Decimal("0.997") : new Decimal("1.003");
  const candles: Candle[] = [];
  let price = new Decimal("100");
  for (let index = 0; index < count; index += 1) {
    const isPullback = index % 4 === 3;
    price = price.times(isPullback ? pullback : step);
    const high = price.times("1.004");
    const low = price.times("0.996");
    const open = index === 0 ? new Decimal("100") : new Decimal(candles[index - 1]!.c);
    const volume = index >= count - 5 ? 140 : 100;
    candles.push({
      contract,
      interval: FIXTURE_TIMEFRAME,
      openTimeSeconds: FIXTURE_START_SECONDS + index * FIXTURE_INTERVAL_SECONDS,
      o: open.toString(),
      h: Decimal.max(high, open, price).toString(),
      l: Decimal.min(low, open, price).toString(),
      c: price.toString(),
      v: volume,
      sum: price.times(volume).toString(),
      windowClosed: true,
    });
  }
  return candles;
}

export function bullishSetupCandles(contract: string, count = 259): Candle[] {
  return setupCandles(contract, "bull", count);
}

export function bearishSetupCandles(contract: string, count = 259): Candle[] {
  return setupCandles(contract, "bear", count);
}

/**
 * Skenario otonom golden (Phase 11).
 *
 * Fase eksplisit supaya pipeline entry→exit benar-benar terlatih:
 *   1. 0..209   tren naik landai dengan pullback → warmup + sinyal LONG
 *   2. 210..217 reli tajam                       → TP trade pertama kena
 *   3. 218..235 konsolidasi                      → peluang LONG berikutnya
 *   4. 236..247 jatuh tajam                      → SL kena
 *   5. 248..275 tren turun landai                → sinyal SHORT
 */
export const AUTONOMOUS_PHASES: readonly { name: string; from: number; to: number }[] = [
  { name: "warmup_bullish", from: 0, to: 210 },
  { name: "rally", from: 210, to: 218 },
  { name: "consolidation", from: 218, to: 250 },
  { name: "crash", from: 250, to: 262 },
  { name: "bearish_setup", from: 262, to: 300 },
];

function autonomousStep(index: number): { step: string; spread: string; volume: number } {
  const phase = AUTONOMOUS_PHASES.find((entry) => index >= entry.from && index < entry.to)!;
  switch (phase.name) {
    case "warmup_bullish":
      return { step: index % 4 === 3 ? "0.997" : "1.0015", spread: "0.004", volume: index >= 205 ? 150 : 100 };
    case "rally":
      return { step: "1.02", spread: "0.006", volume: 160 };
    case "consolidation":
      // Tren naik landai lanjutan dengan pullback: memicu entry KEDUA.
      return { step: index % 4 === 3 ? "0.997" : "1.0015", spread: "0.004", volume: 200 };
    case "crash":
      return { step: "0.985", spread: "0.006", volume: 180 };
    case "bearish_setup":
      // Volume di atas MA20 (yang memuat volume crash) agar volume terkonfirmasi.
      return { step: index % 4 === 3 ? "1.003" : "0.9985", spread: "0.004", volume: 220 };
  }
}

export function autonomousScenarioCandles(contract: string, count = 300): Candle[] {
  const candles: Candle[] = [];
  // Harga realistis: ukuran berbasis risiko pada kontrak bernilai kecil
  // (mis. harga 100) akan melampaui likuiditas buku mana pun.
  let price = new Decimal("80000");
  for (let index = 0; index < count; index += 1) {
    const { step, spread, volume } = autonomousStep(index);
    const open = index === 0 ? price : new Decimal(candles[index - 1]!.c);
    price = open.times(step);
    const high = price.times(new Decimal(1).plus(spread));
    const low = price.times(new Decimal(1).minus(spread));
    candles.push({
      contract,
      interval: FIXTURE_TIMEFRAME,
      openTimeSeconds: FIXTURE_START_SECONDS + index * FIXTURE_INTERVAL_SECONDS,
      o: open.toString(),
      h: Decimal.max(high, open, price).toString(),
      l: Decimal.min(low, open, price).toString(),
      c: price.toString(),
      v: volume,
      sum: price.times(volume).toString(),
      windowClosed: true,
    });
  }
  return candles;
}
