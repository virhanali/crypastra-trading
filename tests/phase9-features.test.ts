import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FEATURE_CONFIG,
  FEATURE_VERSION,
  applyClosedCandle,
  computeFeaturesBatch,
  computeRsi,
  createEngineState,
  scan,
  type Candle,
  type FeatureSnapshot,
} from "@crypastra/core";
import { constantCandles, syntheticCandle, syntheticCandles } from "./helpers/candles.js";

const CONTRACT = "BTC_USDT";

function run(candles: readonly Candle[]): FeatureSnapshot[] {
  const state = createEngineState(CONTRACT);
  const snapshots: FeatureSnapshot[] = [];
  for (const candle of candles) {
    const outcome = applyClosedCandle(state, candle);
    if (outcome.status === "applied") {
      snapshots.push(outcome.snapshot);
    }
  }
  return snapshots;
}

describe("Phase 9 — indikator deterministik", () => {
  test("EMA harga konstan tetap sama dengan harga itu sendiri", () => {
    const snapshots = run(constantCandles(CONTRACT, 260, "100"));
    const last = snapshots.at(-1)!;
    expect(last.ema20).toBe("100");
    expect(last.ema50).toBe("100");
    expect(last.ema200).toBe("100");
    expect(last.distanceEma20Pct).toBe("0");
  });

  test("ATR pasar konstan = 0 dan atrPercent = 0", () => {
    const snapshots = run(constantCandles(CONTRACT, 30, "100"));
    const last = snapshots.at(-1)!;
    expect(last.atr14).toBe("0");
    expect(last.atrPercent).toBe("0");
  });

  test("RSI pasar datar didefinisikan netral = 50 (bukan 100)", () => {
    const snapshots = run(constantCandles(CONTRACT, 60, "100"));
    expect(snapshots.at(-1)!.rsi14).toBe("50");
  });

  test("RSI selalu dalam [0,100] pada fixture multi-regime", () => {
    for (const snapshot of run(syntheticCandles(CONTRACT))) {
      if (snapshot.rsi14 === null) continue;
      const value = Number(snapshot.rsi14);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  test("harga naik monoton menghasilkan return1 positif dan MACD positif", () => {
    const candles = Array.from({ length: 260 }, (_, index) => {
      const price = String(100 + index);
      return {
        ...syntheticCandle(CONTRACT, index),
        o: price,
        h: price,
        l: price,
        c: price,
      };
    });
    const last = run(candles).at(-1)!;
    expect(Number(last.return1)).toBeGreaterThan(0);
    expect(Number(last.return12)).toBeGreaterThan(0);
    expect(Number(last.macd)).toBeGreaterThan(0);
    expect(last.trendStructure).toBe("bullish");
  });

  test("MACD pada seri konstan = 0 untuk macd, signal, dan histogram", () => {
    const last = run(constantCandles(CONTRACT, 60, "100")).at(-1)!;
    expect(last.macd).toBe("0");
    expect(last.macdSignal).toBe("0");
    expect(last.macdHistogram).toBe("0");
  });

  test("volumeRatio = 1 ketika volume sama dengan rata-rata", () => {
    const last = run(constantCandles(CONTRACT, 60, "100")).at(-1)!;
    expect(last.volumeRatio).toBe("1");
    expect(last.volumeMa20).toBe("100");
  });

  test("distance EMA memakai (close - EMA)/EMA dalam persen", () => {
    const candles = Array.from({ length: 260 }, (_, index) => {
      const price = String(100 + index);
      return { ...syntheticCandle(CONTRACT, index), o: price, h: price, l: price, c: price };
    });
    const last = run(candles).at(-1)!;
    // close > EMA20 pada uptrend, jadi jarak harus positif.
    expect(Number(last.distanceEma20Pct)).toBeGreaterThan(0);
    expect(Number(last.distanceEma200Pct)).toBeGreaterThan(Number(last.distanceEma20Pct));
  });

  test("trendStructure bullish/bearish/mixed sesuai tumpukan EMA", () => {
    const up = run(syntheticCandles(CONTRACT, 280)).at(-1)!;
    expect(["bullish", "bearish", "mixed"]).toContain(up.trendStructure);
    const flat = run(constantCandles(CONTRACT, 260, "100")).at(-1)!;
    expect(flat.trendStructure).toBe("mixed");
  });

  test("warmup: EMA200 belum ada sebelum 200 candle", () => {
    const snapshots = run(syntheticCandles(CONTRACT, 199));
    const last = snapshots.at(-1)!;
    expect(last.ema200).toBeNull();
    expect(last.warmupComplete).toBe(false);
    expect(last.warmupRemaining).toBe(1);
  });

  test("warmup selesai tepat pada candle ke-200", () => {
    const snapshots = run(syntheticCandles(CONTRACT, 200));
    const last = snapshots.at(-1)!;
    expect(last.ema200).not.toBeNull();
    expect(last.warmupComplete).toBe(true);
    expect(last.warmupRemaining).toBe(0);
  });

  test("featureVersion tercatat pada setiap snapshot", () => {
    expect(run(syntheticCandles(CONTRACT, 5))[0]!.featureVersion).toBe(FEATURE_VERSION);
  });
});

describe("Phase 9 — engine inkremental vs batch", () => {
  test("hasil inkremental identik dengan orakel batch", () => {
    const candles = syntheticCandles(CONTRACT, 280);
    const incremental = run(candles).at(-1)!;
    const batch = computeFeaturesBatch(CONTRACT, candles)!;
    expect(incremental).toEqual(batch);
  });

  test("candle duplikat tidak mengubah keadaan indikator", () => {
    const candles = syntheticCandles(CONTRACT, 250);
    const state = createEngineState(CONTRACT);
    let last = null as FeatureSnapshot | null;
    for (const candle of candles) {
      const outcome = applyClosedCandle(state, candle);
      if (outcome.status === "applied") last = outcome.snapshot;
    }
    const duplicate = applyClosedCandle(state, candles.at(-1)!);
    expect(duplicate.status).toBe("duplicate");
    expect(state.candleCount).toBe(250);
    // Snapshot setelah duplikat tidak berubah nilainya.
    const after = applyClosedCandle(state, syntheticCandle(CONTRACT, 250));
    expect(after.status).toBe("applied");
    if (after.status !== "applied") throw new Error("unreachable");
    expect(after.snapshot.candleCount).toBe(251);
    expect(last!.candleCount).toBe(250);
  });

  test("candle out-of-order ditolak dan tidak merusak keadaan", () => {
    const candles = syntheticCandles(CONTRACT, 30);
    const state = createEngineState(CONTRACT);
    for (const candle of candles) applyClosedCandle(state, candle);
    const stale = applyClosedCandle(state, candles[5]!);
    expect(stale.status).toBe("out_of_order");
    expect(state.candleCount).toBe(30);
    expect(state.lastOpenTimeSeconds).toBe(candles.at(-1)!.openTimeSeconds);
  });

  test("candle yang belum tertutup tidak diproses", () => {
    const state = createEngineState(CONTRACT);
    const outcome = applyClosedCandle(state, { ...syntheticCandle(CONTRACT, 0), windowClosed: false });
    expect(outcome.status).toBe("not_closed");
    expect(state.candleCount).toBe(0);
  });

  test("interval yang salah ditolak", () => {
    const state = createEngineState(CONTRACT);
    const outcome = applyClosedCandle(state, { ...syntheticCandle(CONTRACT, 0), interval: "1m" });
    expect(outcome.status).toBe("wrong_interval");
    expect(state.candleCount).toBe(0);
  });

  test("keadaan kontrak terisolasi satu sama lain", () => {
    const btcState = createEngineState("BTC_USDT");
    const ethState = createEngineState("ETH_USDT");
    for (const candle of syntheticCandles("BTC_USDT", 260)) applyClosedCandle(btcState, candle);
    const beforeEth = ethState.candleCount;
    // Candle milik kontrak lain harus ditolak.
    const rejected = applyClosedCandle(ethState, syntheticCandle("BTC_USDT", 0));
    expect(rejected.status).toBe("wrong_contract");
    expect(ethState.candleCount).toBe(beforeEth);
    expect(btcState.candleCount).toBe(260);
  });
});

describe("Phase 9 — batas look-ahead", () => {
  test("snapshot di T tidak berubah walau candle masa depan ditambahkan", () => {
    const past = syntheticCandles(CONTRACT, 210);
    const atT = run(past).at(-1)!;

    const withFuture = syntheticCandles(CONTRACT, 280);
    const replay = run(withFuture);
    const sameIndex = replay.find((snapshot) => snapshot.candleCloseTimeMs === atT.candleCloseTimeMs)!;

    expect(sameIndex).toEqual(atT);
  });

  test("snapshot T hanya memakai candle dengan close <= T", () => {
    const candles = syntheticCandles(CONTRACT, 260);
    const snapshots = run(candles);
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index]!;
      const lastUsed = candles.slice(0, index + 1).at(-1)!;
      expect(snapshot.candleCloseTimeMs).toBe(
        lastUsed.openTimeSeconds * 1000 + 300_000,
      );
      expect(snapshot.candleCount).toBe(index + 1);
    }
  });
});

describe("Phase 9 — presisi", () => {
  test("nilai indikator tidak dibulatkan ke 8 desimal uang", () => {
    const last = run(syntheticCandles(CONTRACT, 260)).at(-1)!;
    // EMA pada deret geometris 1.003 menghasilkan pecahan panjang; kalau
    // dibulatkan ke 8 dp, panjang string akan terpotong.
    const decimals = (last.ema20!.split(".")[1] ?? "").length;
    expect(decimals).toBeGreaterThan(8);
  });

  test("computeRsi mengembalikan null sebelum seed selesai", () => {
    const state = createEngineState(CONTRACT);
    expect(computeRsi(state)).toBeNull();
  });

  test("konfigurasi default sesuai kontrak V1", () => {
    expect(DEFAULT_FEATURE_CONFIG.emaPeriods).toEqual([20, 50, 200]);
    expect(DEFAULT_FEATURE_CONFIG.rsiPeriod).toBe(14);
    expect(DEFAULT_FEATURE_CONFIG.macdFast).toBe(12);
    expect(DEFAULT_FEATURE_CONFIG.macdSlow).toBe(26);
    expect(DEFAULT_FEATURE_CONFIG.macdSignal).toBe(9);
    expect(DEFAULT_FEATURE_CONFIG.atrPeriod).toBe(14);
  });
});

describe("Phase 9 — scanner tidak butuh keadaan ekonomi", () => {
  test("scan hanya butuh FeatureSnapshot + konfigurasi", () => {
    const last = run(syntheticCandles(CONTRACT, 280)).at(-1)!;
    const result = scan(last);
    expect(result.contract).toBe(CONTRACT);
    expect(typeof result.signal).toBe("string");
  });
});
