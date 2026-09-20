/**
 * Klien HTTP tipis. SATU-satunya tempat `fetch()` dipanggil.
 *
 * Semua respons keuangan tetap STRING (lihat docs/API.md). Klien tidak
 * mengubah, membulatkan, atau menghitung ulang nilai apa pun.
 */

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ApiClientConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(config: ApiClientConfig = {}) {
    this.#baseUrl = config.baseUrl ?? "/api/v1";
    this.#fetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const body = parsed as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body?.error?.code ?? "HTTP_ERROR",
        body?.error?.message ?? `Permintaan gagal (HTTP ${response.status})`,
        body?.error?.details ?? {},
      );
    }
    return parsed as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, signal === undefined ? {} : { signal });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }
}
