import {
  Decimal,
  JEV_EVALUATOR_VERSION,
  JEV_SCHEMA_VERSION,
  type EvaluatorName,
  type JevEvaluationRequest,
  type JevEvaluationResponse,
  type JevEvaluatorPort,
} from "@crypastra/core";

/**
 * Adapter Jev DETERMINISTIK untuk CI/replay.
 *
 * Tidak ada jaringan, tidak ada `Math.random()`. Probabilitas diturunkan murni
 * dari `inputHash` + nama evaluator, sehingga keadaan pasar/scanner yang sama
 * selalu menghasilkan probabilitas yang sama.
 *
 * Fixture eksplisit dapat dipasang per `inputHash` untuk menguji jalur
 * allow/veto secara terarah.
 */
export interface FakeJevFixture {
  readonly evaluator: EvaluatorName;
  readonly probability?: string;
  readonly regime?: { supportive: string; neutral: string; hostile: string };
  readonly status?: "success" | "invalid" | "unavailable";
  /** Bila true, adapter membuang field wajib untuk menguji validasi. */
  readonly malformed?: boolean;
}

export class DeterministicFakeJevAdapter implements JevEvaluatorPort {
  readonly provider = "fake";
  readonly model = "deterministic-v1";
  readonly #fixtures = new Map<string, FakeJevFixture>();
  #calls = 0;

  constructor(fixtures: readonly { inputHash: string; fixture: FakeJevFixture }[] = []) {
    for (const entry of fixtures) {
      this.#fixtures.set(`${entry.inputHash}:${entry.fixture.evaluator}`, entry.fixture);
    }
  }

  get calls(): number {
    return this.#calls;
  }

  async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse> {
    this.#calls += 1;
    const fixture = this.#fixtures.get(`${request.inputHash}:${request.evaluator}`);
    if (fixture !== undefined) {
      return {
        evaluation: {
          evaluator: request.evaluator,
          evaluatorVersion: JEV_EVALUATOR_VERSION,
          schemaVersion: JEV_SCHEMA_VERSION,
          probability: fixture.probability ?? null,
          regime: fixture.regime ?? null,
          confidence: null,
          reasonCodes: [`FAKE_${request.evaluator.toUpperCase()}`],
          modelMetadata: { fixture: true },
          status: "success",
        },
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
      };
    }

    const p = deterministicProbability(request.inputHash, request.evaluator);
    const regime = deterministicRegime(request.inputHash);
    return {
      evaluation: {
        evaluator: request.evaluator,
        evaluatorVersion: JEV_EVALUATOR_VERSION,
        schemaVersion: JEV_SCHEMA_VERSION,
        probability: request.evaluator === "btc_regime" ? null : p,
        regime: request.evaluator === "btc_regime" ? regime : null,
        confidence: null,
        reasonCodes: [`FAKE_${request.evaluator.toUpperCase()}`],
        modelMetadata: { fixture: false },
        status: "success",
      },
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
    };
  }
}

/** Probabilitas deterministik dari hash: tidak ada acak, tidak ada waktu. */
function deterministicProbability(inputHash: string, evaluator: EvaluatorName): string {
  let acc = 0;
  for (let index = 0; index < inputHash.length; index += 1) {
    acc = (acc * 31 + inputHash.charCodeAt(index) + evaluator.length * (index + 1)) % 1000;
  }
  return new Decimal(acc).div(1000).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toString();
}

function deterministicRegime(inputHash: string): { supportive: string; neutral: string; hostile: string } {
  const supportive = deterministicProbability(inputHash, "btc_regime");
  const neutral = new Decimal(1)
    .minus(supportive)
    .div(2)
    .toDecimalPlaces(3, Decimal.ROUND_HALF_UP)
    .toString();
  const hostile = new Decimal(1)
    .minus(supportive)
    .minus(neutral)
    .toDecimalPlaces(3, Decimal.ROUND_HALF_UP)
    .toString();
  return { supportive, neutral, hostile };
}

/** Adapter yang SELALU gagal — untuk menguji fail-closed. */
export class UnavailableJevAdapter implements JevEvaluatorPort {
  readonly provider = "unavailable";
  readonly model = "none";
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  async evaluate(): Promise<JevEvaluationResponse> {
    this.#calls += 1;
    throw new Error("jev_unavailable");
  }
}
