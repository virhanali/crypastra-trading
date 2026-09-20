import {
  EvaluatorOutputSchema,
  JEV_EVALUATOR_VERSION,
  JEV_PROMPT_VERSION,
  JEV_SCHEMA_VERSION,
  type JevEvaluationRequest,
  type JevEvaluationResponse,
  type JevEvaluatorPort,
} from "@crypastra/core";

/**
 * Adapter Jev nyata (Phase 12).
 *
 * Konfigurasi HANYA dari environment; tidak ada kredensial yang di-hard-code,
 * dipersist, dicatat, atau dimasukkan ke hash. Kegagalan (config hilang, HTTP
 * error, timeout, JSON cacat) MELEMPAR; pemanggil (JevTreatment) menanganinya
 * sebagai `unavailable` dan gagal-tertutup.
 *
 * Batas waktu ditegakkan dengan AbortController supaya permintaan lambat tidak
 * pernah membekukan ingest pasar.
 */
export interface RealJevConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export const REAL_JEV_ENV = {
  baseUrl: "CRYPASTRA_JEV_BASE_URL",
  apiKey: "CRYPASTRA_JEV_API_KEY",
  model: "CRYPASTRA_JEV_MODEL",
  timeoutMs: "CRYPASTRA_JEV_TIMEOUT_MS",
} as const;

/** Baca konfigurasi dari env; null bila tidak lengkap (smoke harus skip jujur). */
export function realJevConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RealJevConfig | null {
  const baseUrl = env[REAL_JEV_ENV.baseUrl];
  const apiKey = env[REAL_JEV_ENV.apiKey];
  const model = env[REAL_JEV_ENV.model] ?? "default";
  if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
    return null;
  }
  const timeoutMs = Number.parseInt(env[REAL_JEV_ENV.timeoutMs] ?? "8000", 10);
  return { baseUrl, apiKey, model, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000 };
}

export class RealJevAdapter implements JevEvaluatorPort {
  readonly provider = "real";
  readonly model: string;
  readonly #config: RealJevConfig;

  constructor(config: RealJevConfig) {
    this.#config = config;
    this.model = config.model;
  }

  async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.#config.baseUrl.replace(/\/$/, "")}/evaluate`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          // Kredensial hanya di header permintaan; tidak pernah dicatat/di-hash.
          authorization: `Bearer ${this.#config.apiKey}`,
        },
        body: JSON.stringify({
          evaluator: request.evaluator,
          evaluatorVersion: request.evaluatorVersion,
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          input: request.input,
        }),
      });
      if (!response.ok) {
        throw new Error(`jev_http_${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const parsed = EvaluatorOutputSchema.safeParse(payload.output);
      if (!parsed.success) {
        throw new Error("jev_malformed_response");
      }
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      return {
        evaluation: {
          evaluator: parsed.data.evaluator,
          evaluatorVersion: parsed.data.evaluatorVersion,
          schemaVersion: parsed.data.schemaVersion,
          probability: parsed.data.probability ?? null,
          regime: parsed.data.regime ?? null,
          confidence: parsed.data.confidence ?? null,
          reasonCodes: [...parsed.data.reasonCodes],
          // Metadata dibatasi: hanya kunci aman, tidak ada echo kredensial.
          modelMetadata: { provider: "real", model: this.model },
          status: "success",
        },
        latencyMs: Date.now() - startedAt,
        inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
        outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const REAL_JEV_DEFAULTS = {
  evaluatorVersion: JEV_EVALUATOR_VERSION,
  promptVersion: JEV_PROMPT_VERSION,
  schemaVersion: JEV_SCHEMA_VERSION,
};
