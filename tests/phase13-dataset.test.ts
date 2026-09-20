import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LABEL_HORIZONS,
  MOMENTUM_ADVERSE_LIMIT_ATR,
  OUTCOME_LABEL_VERSION,
  REVERSAL_ATR_MULTIPLIER,
  TREND_TARGET_THRESHOLD_PCT,
  buildCandidateOutcomeLabel,
  buildDatasetDigest,
  datasetToJsonl,
  outcomeLabelHash,
  type Candle,
  type DatasetRow,
  type JevEvaluationStore,
  type JevEvaluatorPort,
  type EvaluatorName,
  type StoredJevEvaluation,
} from "@crypastra/core";
import { LiveJevCollector, classifyJevError } from "../apps/server/src/treatment/live-jev-collector.js";

const T0 = 1_700_000_000;

function candle(index: number, o: string, h: string, l: string, c: string): Candle {
  return {
    contract: "BTC_USDT", interval: "5m", openTimeSeconds: T0 + (index + 1) * 300,
    o, h, l, c, v: 100, sum: "0", windowClosed: true,
  };
}

function label(overrides: Partial<Parameters<typeof buildCandidateOutcomeLabel>[0]> = {}) {
  return buildCandidateOutcomeLabel({
    inputHash: "h1", contract: "BTC_USDT", timeframe: "5m",
    candleCloseTimeMs: T0 * 1000, direction: "long", referenceClose: "100", atr14: "1",
    futureCandles: [
      candle(0, "100", "101", "99.5", "100.5"),
      candle(1, "100.5", "101.5", "99", "101"),
      candle(2, "101", "102", "100", "101.5"),
      candle(3, "101.5", "103", "101", "102"),
    ],
    ...overrides,
  });
}

describe("Phase 13 — label hasil", () => {
  test("konstanta horizon dan ambang berversi dan tetap", () => {
    expect(LABEL_HORIZONS).toEqual([1, 3, 6, 12]);
    expect(OUTCOME_LABEL_VERSION).toBe("outcome-label-v1");
    expect(TREND_TARGET_THRESHOLD_PCT).toBe("0.25");
    expect(MOMENTUM_ADVERSE_LIMIT_ATR).toBe("1");
    expect(REVERSAL_ATR_MULTIPLIER).toBe("1.5");
  });

  test("return berarah LONG dan SHORT", () => {
    const long = label({ direction: "long" }).horizonLabels.find((entry) => entry.horizon === 1)!;
    expect(long.directionalReturn).toBe("0.005");
    const short = label({ direction: "short" }).horizonLabels.find((entry) => entry.horizon === 1)!;
    expect(short.directionalReturn).toBe("-0.005");
  });

  test("MFE/MAE berarah dari OHLC candle", () => {
    const entry = label().horizonLabels.find((row) => row.horizon === 1)!;
    expect(entry.mfe).toBe("1");    // high 101 − ref 100
    expect(entry.mae).toBe("0.5");  // ref 100 − low 99.5
    const short = label({ direction: "short" }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(short.mfe).toBe("0.5");  // ref − low
    expect(short.mae).toBe("1");    // high − ref
  });

  test("target tren memakai ambang berarah", () => {
    const flat = label({
      futureCandles: [candle(0, "100", "100.1", "99.9", "100.05")],
    }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(flat.trendTarget).toBe(0); // 0.05% < 0.25%
    const strong = label({
      futureCandles: [candle(0, "100", "100.5", "99.9", "100.4")],
    }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(strong.trendTarget).toBe(1); // 0.4% >= 0.25%
  });

  test("target momentum: kontinuasi dengan ekskursi adverse terbatas", () => {
    const good = label().horizonLabels.find((row) => row.horizon === 1)!;
    expect(good.momentumTarget).toBe(1); // return > 0 dan MAE 0.5 <= ATR×1
    const choppy = label({
      futureCandles: [candle(0, "100", "100.2", "97", "100.1")],
    }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(choppy.momentumTarget).toBe(0); // MAE 3 > 1
  });

  test("target reversal memakai ambang ATR-normalisasi", () => {
    const calm = label().horizonLabels.find((row) => row.horizon === 1)!;
    expect(calm.reversalTarget).toBe(0); // MAE 0.5 < 1.5
    const violent = label({
      futureCandles: [candle(0, "100", "100.2", "98", "99")],
    }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(violent.reversalTarget).toBe(1); // MAE 2 >= 1.5
  });

  test("riwayat masa depan kurang → incomplete, tidak dipotong diam-diam", () => {
    const short = label({ horizons: [1, 3, 6, 12] });
    expect(short.status).toBe("incomplete");
    expect(short.incompleteReason).toContain("kurang dari");
    const h1 = short.horizonLabels.find((row) => row.horizon === 1)!;
    const h12 = short.horizonLabels.find((row) => row.horizon === 12)!;
    expect(h1.directionalReturn).not.toBeNull();
    expect(h12.directionalReturn).toBeNull();
    expect(h12.trendTarget).toBeNull();
  });

  test("ATR tidak tersedia → target momentum/reversal null (bukan 0)", () => {
    const entry = label({ atr14: null }).horizonLabels.find((row) => row.horizon === 1)!;
    expect(entry.momentumTarget).toBeNull();
    expect(entry.reversalTarget).toBeNull();
    expect(entry.trendTarget).not.toBeNull();
  });

  test("label deterministik dan hash stabil", () => {
    expect(label()).toEqual(label());
    expect(outcomeLabelHash(label())).toBe(outcomeLabelHash(label()));
    expect(outcomeLabelHash(label({ direction: "short" }))).not.toBe(outcomeLabelHash(label()));
  });

  test("sumber harga didokumentasikan sebagai satu sumber", () => {
    expect(label().priceSource).toBe("candle_ohlc");
  });
});

describe("Phase 13 — dataset export", () => {
  function row(overrides: Partial<DatasetRow> = {}): DatasetRow {
    return {
      datasetVersion: "dataset-v1", sessionId: "s1", contract: "BTC_USDT", timeframe: "5m",
      candleCloseTimeMs: 1, direction: "long", featureVersion: "features-v1",
      scannerVersion: "scanner-v1", scannerConfigHash: "sh", jevInputHash: "ih",
      evaluations: [], candidateStatus: "complete", treatmentStatus: "allow",
      treatmentReasons: ["JEV_TREATMENT_ALLOWED"], labels: null, ...overrides,
    };
  }

  test("urutan kanonik → JSONL dan hash identik", () => {
    const rows = [
      row({ candleCloseTimeMs: 2, contract: "ETH_USDT" }),
      row({ candleCloseTimeMs: 1, contract: "BTC_USDT" }),
      row({ candleCloseTimeMs: 1, contract: "BTC_USDT", direction: "short" }),
    ];
    const first = datasetToJsonl(rows);
    const second = datasetToJsonl([...rows].reverse());
    expect(first).toBe(second);
    expect(buildDatasetDigest(rows).combinedHash).toBe(buildDatasetDigest([...rows].reverse()).combinedHash);
  });

  test("digest melaporkan distribusi tanpa id DB/jam dinding", () => {
    const digest = buildDatasetDigest([row(), row({ direction: "short", treatmentStatus: "veto" })]);
    expect(digest.rowCount).toBe(2);
    expect(digest.directionDistribution).toEqual({ long: 1, short: 1 });
    expect(digest.treatmentDistribution).toEqual({ allow: 1, veto: 1 });
    expect(digest.labelStatusDistribution).toEqual({ missing: 2 });
  });

  test("ekspor TIDAK memuat akun/wallet/rahasia", () => {
    const serialized = datasetToJsonl([row({ labels: label() })]);
    for (const token of ["accountId", "wallet", "balance", "margin", "ledger", "apiKey", "secret", "equity"]) {
      expect(serialized.includes(token)).toBe(false);
    }
  });
});

describe("Phase 13 — batas kebocoran (leakage)", () => {
  test("modul label tidak diimpor jalur perlakuan/keputusan/eksekusi", () => {
    const forbidden = ["labels/outcome-label", "labels/dataset", "CandidateOutcomeLabel", "outcomeLabel", "candidate-outcome-label"];
    for (const dir of [
      "packages/core/src/treatment",
      "packages/core/src/decision",
      "apps/server/src/treatment",
      "apps/server/src/decision",
      "apps/server/src/execution",
    ]) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue;
        const source = strip(readFileSync(join(dir, file), "utf8"));
        for (const token of forbidden) {
          expect(source.includes(token)).toBe(false);
        }
      }
    }
  });

  test("labeler hanya ada di jalur riset offline", () => {
    const research = readdirSync("apps/server/src/research");
    expect(research).toContain("outcome-labeler.ts");
    // Live collector tidak menyentuh label.
    const collector = strip(readFileSync("apps/server/src/treatment/live-jev-collector.ts", "utf8"));
    expect(collector.toLowerCase().includes("label")).toBe(false);
  });

  test("kontrak inti Jev tidak memuat tipe label", () => {
    const types = strip(readFileSync("packages/core/src/treatment/types.ts", "utf8"));
    expect(types.includes("OutcomeLabel")).toBe(false);
  });
});

describe("Phase 13 — kolektor Jev terbatas", () => {
  class Store implements JevEvaluationStore {
    readonly rows = new Map<string, StoredJevEvaluation>();
    find(i: { inputHash: string; evaluator: EvaluatorName; evaluatorVersion: string; promptVersion: string; schemaVersion: string; provider: string; model: string }) {
      return this.rows.get([i.inputHash, i.evaluator, i.evaluatorVersion, i.promptVersion, i.schemaVersion, i.provider, i.model].join(":")) ?? null;
    }
    save(input: Parameters<JevEvaluationStore["save"]>[0]) {
      this.rows.set(
        [input.inputHash, input.evaluator, input.identity.evaluatorVersion, input.identity.promptVersion, input.identity.schemaVersion, input.identity.provider, input.identity.model].join(":"),
        { evaluation: input.evaluation, latencyMs: 0, inputTokens: null, outputTokens: null },
      );
    }
  }

  function jevInput(hash: string) {
    return { inputHash: hash } as never;
  }

  function port(behavior: "ok" | "timeout" | "invalid" | "fatal" = "ok"): JevEvaluatorPort & { calls: number } {
    const state = { calls: 0 };
    return {
      provider: "test", model: "test",
      get calls() { return state.calls; },
      async evaluate(request) {
        state.calls += 1;
        if (behavior === "timeout") throw new Error("jev_timeout");
        if (behavior === "fatal") throw new Error("jev_http_401");
        if (behavior === "invalid") throw new Error("jev_malformed_response");
        return {
          evaluation: {
            evaluator: request.evaluator, evaluatorVersion: "jev-eval-v1", schemaVersion: "jev-schema-v1",
            probability: "0.8", regime: null, confidence: null, reasonCodes: ["T"], modelMetadata: {}, status: "success" as const,
          },
          latencyMs: 0, inputTokens: null, outputTokens: null,
        };
      },
    };
  }

  const evaluators: EvaluatorName[] = ["trend_alignment", "momentum_sustainability", "reversal_risk"];

  test("antrean penuh membuang permintaan tanpa memblokir", async () => {
    const store = new Store();
    const slow: JevEvaluatorPort = {
      provider: "test", model: "test",
      evaluate: () => new Promise((resolve) => setTimeout(() => resolve({ evaluation: { evaluator: "trend_alignment", evaluatorVersion: "jev-eval-v1", schemaVersion: "jev-schema-v1", probability: "0.5", regime: null, confidence: null, reasonCodes: [], modelMetadata: {}, status: "success" }, latencyMs: 0, inputTokens: null, outputTokens: null }), 30)),
    };
    const collector = new LiveJevCollector({ port: slow, store, evaluators, queueCapacity: 1, concurrency: 1, timeoutMs: 0 });
    expect(collector.enqueue({ input: jevInput("a"), inputHash: "a" })).toBe(true);
    expect(collector.enqueue({ input: jevInput("b"), inputHash: "b" })).toBe(false);
    expect(collector.status().queueDropped).toBe(1);
    await collector.drain();
  });

  test("kandidat lengkap hanya bila seluruh evaluator berhasil", async () => {
    const store = new Store();
    const collector = new LiveJevCollector({ port: port("ok"), store, evaluators, timeoutMs: 0, retryDelayMs: 1 });
    collector.enqueue({ input: jevInput("h"), inputHash: "h" });
    await collector.drain();
    expect(collector.candidateStatus("h")).toBe("complete");
    expect(collector.status().success).toBe(3);
  });

  test("timeout diulang terbatas lalu menjadi unavailable (bukan complete)", async () => {
    const store = new Store();
    const failing = port("timeout");
    const collector = new LiveJevCollector({ port: failing, store, evaluators, timeoutMs: 0, maxRetries: 1, retryDelayMs: 1 });
    collector.enqueue({ input: jevInput("t"), inputHash: "t" });
    await collector.drain();
    // Percobaan ulang TERBATAS: 1 percobaan awal + maxRetries, masing-masing
    // menyentuh seluruh evaluator yang masih gagal (tidak ada yang tercache).
    expect(collector.status().retryCount).toBe(1);
    expect(collector.candidateStatus("t")).not.toBe("complete");
    expect(failing.calls).toBe((1 + 1) * evaluators.length);
  });

  test("output cacat tidak dihantam berulang", async () => {
    const store = new Store();
    const failing = port("invalid");
    const collector = new LiveJevCollector({ port: failing, store, evaluators, timeoutMs: 0, maxRetries: 3, retryDelayMs: 1 });
    collector.enqueue({ input: jevInput("i"), inputHash: "i" });
    await collector.drain();
    expect(collector.status().retryCount).toBe(0);
    expect(collector.candidateStatus("i")).toBe("invalid");
  });

  test("error auth bersifat fatal, bukan retry", async () => {
    const store = new Store();
    const failing = port("fatal");
    const collector = new LiveJevCollector({ port: failing, store, evaluators, timeoutMs: 0, maxRetries: 3, retryDelayMs: 1 });
    collector.enqueue({ input: jevInput("f"), inputHash: "f" });
    await collector.drain();
    expect(collector.status().fatalErrors).toBeGreaterThan(0);
    expect(collector.status().retryCount).toBe(0);
  });

  test("klasifikasi error eksplisit", () => {
    expect(classifyJevError(new Error("jev_timeout"))).toBe("retryable");
    expect(classifyJevError(new Error("jev_http_429"))).toBe("retryable");
    expect(classifyJevError(new Error("jev_http_503"))).toBe("retryable");
    expect(classifyJevError(new Error("jev_http_401"))).toBe("fatal");
    expect(classifyJevError(new Error("jev_malformed_response"))).toBe("invalid");
  });

  test("evaluasi tercache tidak dipanggil ulang", async () => {
    const store = new Store();
    const cached = port("ok");
    const first = new LiveJevCollector({ port: cached, store, evaluators, timeoutMs: 0 });
    first.enqueue({ input: jevInput("c"), inputHash: "c" });
    await first.drain();
    expect(cached.calls).toBe(3);
    const second = new LiveJevCollector({ port: cached, store, evaluators, timeoutMs: 0 });
    expect(second.enqueue({ input: jevInput("c"), inputHash: "c" })).toBe(true);
    await second.drain();
    expect(cached.calls).toBe(3);
    expect(second.status().cacheHits).toBe(3);
  });

  test("batas laju tercatat dan tidak memblokir ingest", async () => {
    const store = new Store();
    let now = 0;
    const collector = new LiveJevCollector({
      port: port("ok"), store, evaluators, timeoutMs: 0,
      requestsPerMinute: 1, concurrency: 1, clock: { nowMs: () => now },
    });
    collector.enqueue({ input: jevInput("r1"), inputHash: "r1" });
    collector.enqueue({ input: jevInput("r2"), inputHash: "r2" });
    const draining = collector.drain();
    await new Promise((resolve) => setTimeout(resolve, 30));
    now += 61_000; // jendela laju bergeser
    await draining;
    expect(collector.status().rateLimited).toBeGreaterThan(0);
  });
});

function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
