import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_JEV_VETO_CONFIG,
  DEFAULT_RISK_POLICY,
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  JevTreatment,
  NoTreatment,
  applyJevVetoPolicy,
  buildJevInput,
  collectJevEvaluations,
  decide,
  jevInputHash,
  jevVetoConfigHash,
  validateEvaluatorOutput,
  type EvaluatorEvaluation,
  type EvaluatorName,
  type JevEvaluationStore,
  type JevEvaluatorPort,
  type JevInput,
  type StoredJevEvaluation,
} from "@crypastra/core";
import { DeterministicFakeJevAdapter, UnavailableJevAdapter } from "@crypastra/adapters";
import { account, market, scannerResult, snapshot } from "./helpers/decision.js";
import { BTC_USDT, ETH_USDT } from "./helpers/fixtures.js";

/** Store in-memory untuk test (inti tidak boleh tahu DB). */
class MemoryStore implements JevEvaluationStore {
  readonly rows = new Map<string, StoredJevEvaluation>();

  #key(input: { inputHash: string; evaluator: EvaluatorName } & Record<string, string>): string {
    return [
      input.inputHash, input.evaluator, input.evaluatorVersion,
      input.promptVersion, input.schemaVersion, input.provider, input.model,
    ].join(":");
  }

  find(identity: {
    inputHash: string; evaluator: EvaluatorName; evaluatorVersion: string;
    promptVersion: string; schemaVersion: string; provider: string; model: string;
  }): StoredJevEvaluation | null {
    return this.rows.get(this.#key(identity as never)) ?? null;
  }

  save(input: Parameters<JevEvaluationStore["save"]>[0]): void {
    this.rows.set(
      this.#key({
        inputHash: input.inputHash, evaluator: input.evaluator,
        evaluatorVersion: input.identity.evaluatorVersion, promptVersion: input.identity.promptVersion,
        schemaVersion: input.identity.schemaVersion, provider: input.identity.provider, model: input.identity.model,
      }),
      { evaluation: input.evaluation, latencyMs: input.latencyMs, inputTokens: input.inputTokens, outputTokens: input.outputTokens },
    );
  }
}

function input(overrides: Partial<JevInput> = {}): JevInput {
  const built = buildJevInput({
    features: snapshot({ atr14: "400" }),
    scanner: scannerResult({ signal: "long" }),
    btcContext: null,
    direction: "long",
  });
  return { ...built, ...overrides };
}

function evaluation(evaluator: EvaluatorName, probability: string, status: EvaluatorEvaluation["status"] = "success"): EvaluatorEvaluation {
  return {
    evaluator, evaluatorVersion: JEV_EVALUATOR_VERSION, schemaVersion: JEV_SCHEMA_VERSION,
    probability, regime: null, confidence: null, reasonCodes: ["T"], modelMetadata: {}, status,
  };
}

function seed(store: MemoryStore, jevInput: JevInput, values: Record<string, string>) {
  const hash = jevInputHash(jevInput);
  for (const [evaluator, probability] of Object.entries(values)) {
    store.save({
      input: jevInput, inputHash: hash, evaluator: evaluator as EvaluatorName,
      identity: { evaluatorVersion: JEV_EVALUATOR_VERSION, promptVersion: JEV_PROMPT_VERSION, schemaVersion: JEV_SCHEMA_VERSION, provider: "fake", model: "deterministic-v1" },
      evaluation: evaluation(evaluator as EvaluatorName, probability),
      latencyMs: 0, inputTokens: null, outputTokens: null, createdAtMs: 0,
    });
  }
}

function treatment(store: JevEvaluationStore, config = DEFAULT_JEV_VETO_CONFIG) {
  return new JevTreatment({ store, config, provider: "fake", model: "deterministic-v1" });
}

const GOOD = { trend_alignment: "0.8", momentum_sustainability: "0.8", reversal_risk: "0.2" };

describe("Phase 12 — input Jev & hash", () => {
  test("input berisi konteks pasar dan TIDAK memuat informasi akun/privat", () => {
    const jevInput = input();
    const serialized = JSON.stringify(jevInput);
    for (const token of ["accountId", "wallet", "equity", "margin", "leverage", "balance", "pnl", "size", "riskBudget"]) {
      expect(serialized.includes(token)).toBe(false);
    }
    expect(jevInput.contract).toBe("BTC_USDT");
    expect(jevInput.direction).toBe("long");
  });

  test("hash stabil untuk keadaan yang sama dan sensitif terhadap perubahan", () => {
    expect(jevInputHash(input())).toBe(jevInputHash(input()));
    expect(jevInputHash(input())).not.toBe(jevInputHash(input({ close: "99999" })));
  });

  test("hash tidak bergantung pada waktu/jam dinding", () => {
    const first = jevInputHash(input());
    const second = jevInputHash(input());
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(second);
  });

  test("tidak ada informasi masa depan: snapshot T tidak berubah oleh data setelah T", () => {
    const atT = input();
    const laterInput = input({ close: "81000", candleCloseTimeMs: 9_999_999 });
    expect(jevInputHash(atT)).not.toBe(jevInputHash(laterInput));
    expect(atT.candleCloseTimeMs).toBe(1_700_000_300_000);
  });

  test("konteks BTC ikut masuk hash bila ada", () => {
    const withBtc = buildJevInput({
      features: snapshot(), scanner: scannerResult({ contract: "ETH_USDT" }),
      btcContext: { contract: "BTC_USDT", trendStructure: "bullish", return1: "0.01", return12: "0.05", atrPercent: "1.2", close: "80000" },
      direction: "long",
    });
    expect(jevInputHash(withBtc)).not.toBe(jevInputHash(input()));
    expect(withBtc.btc?.trendStructure).toBe("bullish");
  });
});

describe("Phase 12 — validasi output eksternal", () => {
  test("menerima probabilitas dalam [0,1]", () => {
    const outcome = validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, {
      evaluator: "trend_alignment", evaluatorVersion: "v", schemaVersion: JEV_SCHEMA_VERSION,
      probability: "0.73", reasonCodes: ["OK"], modelMetadata: {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.evaluation!.probability).toBe("0.73");
  });

  test("menolak evaluator salah, skema salah, NaN, dan di luar rentang", () => {
    const base = { evaluatorVersion: "v", schemaVersion: JEV_SCHEMA_VERSION, reasonCodes: [], modelMetadata: {} };
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, evaluator: "reversal_risk", probability: "0.5" }).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, evaluator: "trend_alignment", schemaVersion: "other", probability: "0.5" }).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, evaluator: "trend_alignment", probability: "NaN" }).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, evaluator: "trend_alignment", probability: "1.5" }).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, evaluator: "trend_alignment", probability: "-0.1" }).ok).toBe(false);
  });

  test("menolak JSON cacat dan field tak dikenal (strict)", () => {
    const base = { evaluator: "trend_alignment", evaluatorVersion: "v", schemaVersion: JEV_SCHEMA_VERSION, probability: "0.5", reasonCodes: [], modelMetadata: {} };
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, null).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, "prosa bebas").ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, aiConfidence: "0.9" }).ok).toBe(false);
    expect(validateEvaluatorOutput("trend_alignment", JEV_SCHEMA_VERSION, { ...base, probability: undefined }).ok).toBe(false);
  });

  test("btc_regime wajib membawa tiga probabilitas", () => {
    const base = { evaluator: "btc_regime", evaluatorVersion: "v", schemaVersion: JEV_SCHEMA_VERSION, reasonCodes: [], modelMetadata: {} };
    expect(validateEvaluatorOutput("btc_regime", JEV_SCHEMA_VERSION, base).ok).toBe(false);
    const ok = validateEvaluatorOutput("btc_regime", JEV_SCHEMA_VERSION, {
      ...base, regime: { supportive: "0.2", neutral: "0.3", hostile: "0.5" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.evaluation!.regime!.hostile).toBe("0.5");
  });
});

describe("Phase 12 — adapter fake deterministik", () => {
  test("output deterministik dan tanpa jaringan/acak", async () => {
    const fake = new DeterministicFakeJevAdapter();
    const request = {
      input: input(), inputHash: jevInputHash(input()), evaluator: "trend_alignment" as EvaluatorName,
      evaluatorVersion: JEV_EVALUATOR_VERSION, promptVersion: JEV_PROMPT_VERSION, schemaVersion: JEV_SCHEMA_VERSION,
    };
    const first = await fake.evaluate(request);
    const second = await fake.evaluate(request);
    expect(first.evaluation.probability).toBe(second.evaluation.probability);
    const value = Number(first.evaluation.probability);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  test("fixture eksplisit dapat memaksa hasil tertentu", async () => {
    const fake = new DeterministicFakeJevAdapter([
      { inputHash: "abc", fixture: { evaluator: "trend_alignment", probability: "0.99" } },
    ]);
    const response = await fake.evaluate({
      input: input(), inputHash: "abc", evaluator: "trend_alignment",
      evaluatorVersion: JEV_EVALUATOR_VERSION, promptVersion: JEV_PROMPT_VERSION, schemaVersion: JEV_SCHEMA_VERSION,
    });
    expect(response.evaluation.probability).toBe("0.99");
  });
});

describe("Phase 12 — cache", () => {
  test("hit kedua memakai hasil tersimpan tanpa panggilan kedua", async () => {
    const store = new MemoryStore();
    const fake = new DeterministicFakeJevAdapter();
    const jevInput = input();
    const first = await collectJevEvaluations(
      { input: jevInput, inputHash: jevInputHash(jevInput) },
      { port: fake, store, evaluators: ["trend_alignment"], timeoutMs: 0 },
    );
    expect(first.successes).toBe(1);
    expect(first.cacheMisses).toBe(1);
    const second = await collectJevEvaluations(
      { input: jevInput, inputHash: jevInputHash(jevInput) },
      { port: fake, store, evaluators: ["trend_alignment"], timeoutMs: 0 },
    );
    expect(second.cacheHits).toBe(1);
    expect(second.requests).toBe(0);
    expect(fake.calls).toBe(1);
  });

  test("versi prompt berbeda menghasilkan identitas cache berbeda", async () => {
    const store = new MemoryStore();
    const fake = new DeterministicFakeJevAdapter();
    const jevInput = input();
    const key = { input: jevInput, inputHash: jevInputHash(jevInput) };
    await collectJevEvaluations(key, { port: fake, store, evaluators: ["trend_alignment"], timeoutMs: 0, promptVersion: "p1" });
    const other = await collectJevEvaluations(key, { port: fake, store, evaluators: ["trend_alignment"], timeoutMs: 0, promptVersion: "p2" });
    expect(other.cacheMisses).toBe(1);
    expect(store.rows.size).toBe(2);
  });

  test("adapter tidak tersedia → unavailable (fail closed), bukan throw", async () => {
    const store = new MemoryStore();
    const counters = await collectJevEvaluations(
      { input: input(), inputHash: jevInputHash(input()) },
      { port: new UnavailableJevAdapter(), store, evaluators: ["trend_alignment"], timeoutMs: 0 },
    );
    expect(counters.unavailable).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  test("timeout dihitung sebagai unavailable", async () => {
    const slow: JevEvaluatorPort = {
      provider: "slow", model: "slow",
      evaluate: () => new Promise((resolve) => setTimeout(resolve, 50)),
    };
    const counters = await collectJevEvaluations(
      { input: input(), inputHash: jevInputHash(input()) },
      { port: slow, store: new MemoryStore(), evaluators: ["trend_alignment"], timeoutMs: 5 },
    );
    expect(counters.unavailable).toBe(1);
  });
});

describe("Phase 12 — kebijakan veto deterministik", () => {
  const evals = (values: Record<string, string>, regime?: { supportive: string; neutral: string; hostile: string }) => ({
    trendAlignment: evaluation("trend_alignment", values.trend_alignment!),
    momentumSustainability: evaluation("momentum_sustainability", values.momentum_sustainability!),
    reversalRisk: evaluation("reversal_risk", values.reversal_risk!),
    btcRegime: regime === undefined ? null : { ...evaluation("btc_regime", "0"), regime },
  });

  test("ALLOW ketika semua ambang terpenuhi", () => {
    const decision = applyJevVetoPolicy(evals(GOOD));
    expect(decision.status).toBe("allow");
    expect(decision.reasons).toEqual(["JEV_TREATMENT_ALLOWED"]);
  });

  test("VETO trend, momentum, dan reversal dengan reason code masing-masing", () => {
    expect(applyJevVetoPolicy(evals({ ...GOOD, trend_alignment: "0.1" })).reasons).toContain("JEV_TREND_ALIGNMENT_BELOW_MINIMUM");
    expect(applyJevVetoPolicy(evals({ ...GOOD, momentum_sustainability: "0.1" })).reasons).toContain("JEV_MOMENTUM_UNSUSTAINABLE");
    expect(applyJevVetoPolicy(evals({ ...GOOD, reversal_risk: "0.9" })).reasons).toContain("JEV_REVERSAL_RISK_TOO_HIGH");
  });

  test("VETO BTC hostile hanya bila evaluatornya diwajibkan", () => {
    const hostile = { supportive: "0.1", neutral: "0.1", hostile: "0.8" };
    expect(applyJevVetoPolicy(evals(GOOD, hostile)).status).toBe("allow");
    const config = { ...DEFAULT_JEV_VETO_CONFIG, requireBtcEvaluator: true };
    expect(applyJevVetoPolicy(evals(GOOD, hostile), config).reasons).toContain("JEV_BTC_REGIME_HOSTILE");
    expect(applyJevVetoPolicy(evals(GOOD, { supportive: "0.7", neutral: "0.2", hostile: "0.1" }), config).status).toBe("allow");
  });

  test("evaluator hilang → unavailable (fail closed)", () => {
    const decision = applyJevVetoPolicy({ trendAlignment: null, momentumSustainability: null, reversalRisk: null, btcRegime: null });
    expect(decision.status).toBe("unavailable");
  });

  test("config hash stabil dan sensitif", () => {
    expect(jevVetoConfigHash(DEFAULT_JEV_VETO_CONFIG)).toBe(jevVetoConfigHash({ ...DEFAULT_JEV_VETO_CONFIG }));
    expect(jevVetoConfigHash(DEFAULT_JEV_VETO_CONFIG)).not.toBe(
      jevVetoConfigHash({ ...DEFAULT_JEV_VETO_CONFIG, minimumTrendAlignment: "0.9" }),
    );
  });
});

describe("Phase 12 — perlakuan", () => {
  test("CONTROL selalu ALLOW tanpa evaluasi", async () => {
    const result = await new NoTreatment().evaluate({ input: input(), inputHash: "h", direction: "long" });
    expect(result.status).toBe("allow");
    expect(result.reasons).toEqual(["TREATMENT_NONE"]);
  });

  test("store kosong → unavailable (fail closed), tidak fallback ke baseline", () => {
    const result = treatment(new MemoryStore()).evaluate({ input: input(), inputHash: jevInputHash(input()), direction: "long" });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["JEV_UNAVAILABLE"]);
  });

  test("evaluasi lengkap → allow; lemah → veto dengan reason code", () => {
    const store = new MemoryStore();
    const jevInput = input();
    seed(store, jevInput, GOOD);
    const allowed = treatment(store).evaluate({ input: jevInput, inputHash: jevInputHash(jevInput), direction: "long" });
    expect(allowed.status).toBe("allow");

    const weakStore = new MemoryStore();
    seed(weakStore, jevInput, { ...GOOD, trend_alignment: "0.05" });
    const vetoed = treatment(weakStore).evaluate({ input: jevInput, inputHash: jevInputHash(jevInput), direction: "long" });
    expect(vetoed.status).toBe("veto");
    expect(vetoed.reasons).toContain("JEV_TREND_ALIGNMENT_BELOW_MINIMUM");
  });

  test("output tidak valid → invalid (fail closed)", () => {
    const store = new MemoryStore();
    const jevInput = input();
    const hash = jevInputHash(jevInput);
    // Satu evaluator tidak valid, dua lainnya valid: status perlakuan = invalid.
    store.save({
      input: jevInput, inputHash: hash, evaluator: "trend_alignment",
      identity: { evaluatorVersion: JEV_EVALUATOR_VERSION, promptVersion: JEV_PROMPT_VERSION, schemaVersion: JEV_SCHEMA_VERSION, provider: "fake", model: "deterministic-v1" },
      evaluation: evaluation("trend_alignment", "0.9", "invalid"),
      latencyMs: null, inputTokens: null, outputTokens: null, createdAtMs: 0,
    });
    seed(store, jevInput, { momentum_sustainability: "0.8", reversal_risk: "0.2" });
    const result = treatment(store).evaluate({ input: jevInput, inputHash: hash, direction: "long" });
    expect(result.status).toBe("invalid");
  });

  test("evaluasi deterministik: dua evaluasi identik", () => {
    const store = new MemoryStore();
    const jevInput = input();
    seed(store, jevInput, GOOD);
    const instance = treatment(store);
    const first = instance.evaluate({ input: jevInput, inputHash: jevInputHash(jevInput), direction: "long" });
    const second = instance.evaluate({ input: jevInput, inputHash: jevInputHash(jevInput), direction: "long" });
    expect(second).toEqual(first);
  });
});

describe("Phase 12 — Jev TIDAK dapat mengubah risiko", () => {
  test("DecisionEngine menghasilkan TradePlan identik dengan/tanpa perlakuan", () => {
    const features = snapshot({ atr14: "400" });
    const scanner = scannerResult({ signal: "long" });
    const input = {
      contract: "BTC_USDT", timeframe: "5m", candleCloseTimeMs: features.candleCloseTimeMs,
      accountId: "a", features, scanner, spec: BTC_USDT,
      market: market({ bestAsk: "80000", bestBid: "79995" }), account: account(), policy: DEFAULT_RISK_POLICY,
    };
    const baseline = decide(input);
    // Perlakuan tidak terhubung ke DecisionEngine: tidak ada parameter perlakuan.
    const again = decide(input);
    expect(again).toEqual(baseline);
    expect(Object.keys(input).some((key) => key.includes("jev") || key.includes("treatment"))).toBe(false);
    expect(baseline.tradePlan!.size).toBe(125);
    expect(baseline.tradePlan!.leverage).toBe("10");
  });

  test("guard impor: perlakuan tidak menyentuh eksekusi/ledger/akun/risiko", () => {
    const forbidden = [
      "order-service", "trade-execution-service", "ledger", "account-repository",
      "position-repository", "OrderService", "LedgerRepository", "AccountRepository",
      "PositionRepository", "matching", "fetch(", "drizzle",
    ];
    for (const file of readdirSync("packages/core/src/treatment")) {
      const source = stripComments(readFileSync(join("packages/core/src/treatment", file), "utf8"));
      for (const token of forbidden) {
        expect(source.includes(token)).toBe(false);
      }
    }
    // risk-v1 tidak boleh mengimpor Jev.
    const risk = stripComments(readFileSync("packages/core/src/decision/risk-policy.ts", "utf8"));
    expect(risk.toLowerCase().includes("jev")).toBe(false);
  });

  test("adapter Jev tidak tahu Paper Exchange", () => {
    for (const file of readdirSync("packages/adapters/src/jev")) {
      const source = stripComments(readFileSync(join("packages/adapters/src/jev", file), "utf8"));
      for (const token of ["order-service", "OrderService", "ledger", "position", "matching", "risk-v1"]) {
        expect(source.includes(token)).toBe(false);
      }
    }
  });

  test("tidak ada kredensial yang bocor ke hash/metadata", () => {
    const source = readFileSync("packages/adapters/src/jev/real-jev-adapter.ts", "utf8");
    // Kunci hanya dipakai di header permintaan.
    expect(source).toContain("authorization");
    expect(source).not.toContain("modelMetadata: { apiKey");
    expect(source).not.toContain("apiKey: this.#config.apiKey");
  });
});

describe("Phase 12 — kompatibilitas kontrak desimal", () => {
  test("perlakuan bekerja untuk kandidat kontrak desimal (ukuran pecahan)", () => {
    const features = snapshot({ contract: "ETH_USDT", close: "3000", atr14: "15" });
    const scanner = scannerResult({ contract: "ETH_USDT", signal: "long" });
    const jevInput = buildJevInput({ features, scanner, btcContext: null, direction: "long" });
    const store = new MemoryStore();
    seed(store, jevInput, GOOD);
    const result = treatment(store).evaluate({ input: jevInput, inputHash: jevInputHash(jevInput), direction: "long" });
    expect(result.status).toBe("allow");

    // Dan keputusan tetap menghasilkan ukuran pecahan seperti sebelumnya.
    const decision = decide({
      contract: "ETH_USDT", timeframe: "5m", candleCloseTimeMs: features.candleCloseTimeMs,
      accountId: "a", features, scanner, spec: ETH_USDT,
      market: market({ bestAsk: "3000", bestBid: "2999" }), account: account(), policy: DEFAULT_RISK_POLICY,
    });
    expect(Number.isInteger(decision.tradePlan!.size)).toBe(false);
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 12 — determinisme replay dengan evaluasi tercache", () => {
  test("dua run treatment menghasilkan hash ekonomi dan hasil perlakuan identik", async () => {
    const { runReplay } = await import("./helpers/ab.js");
    const first = await runReplay("treatment");
    const second = await runReplay("treatment");
    expect(first.result.hashes).toEqual(second.result.hashes);
    expect(first.result.balances).toEqual(second.result.balances);
    expect(first.treatmentStatuses).toEqual(second.treatmentStatuses);
    expect(first.metrics).toEqual(second.metrics);
    expect(first.result.orderCount).toBe(second.result.orderCount);
  }, 120_000);

  test("CONTROL tidak berubah oleh kehadiran lapisan perlakuan", async () => {
    const { runReplay } = await import("./helpers/ab.js");
    const control = await runReplay("control");
    const treatment = await runReplay("treatment");
    // Tanpa perlakuan, ekonomi kontrol tetap yang lama; dengan perlakuan yang
    // memveto, jumlah trade bisa berkurang — tetapi hash kontrol harus identik
    // dengan run kontrol lain.
    const controlAgain = await runReplay("control");
    expect(controlAgain.result.hashes).toEqual(control.result.hashes);
    expect(control.metrics.tradeCount).toBeGreaterThanOrEqual(treatment.metrics.tradeCount);
  }, 120_000);
});
