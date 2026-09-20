import type { WebSocketLike } from "./domain-stream.js";

/**
 * Stream pasar EPHEMERAL (Phase 6).
 *
 * Berbeda dari peristiwa domain:
 *  - TIDAK punya `seq`, tidak dapat di-resume;
 *  - keadaan terbaru menggantikan yang lama (coalescing);
 *  - aman untuk dibuang.
 *
 * Karena itu stream ini TIDAK dipakai untuk keputusan akuntansi; ia hanya
 * memasok tampilan pasar (mark/last/index/bid/ask/candle).
 */

export type MarketEventType = "market.mark" | "market.book" | "market.candle" | "market.status";

export interface MarketEvent {
  readonly type: MarketEventType;
  readonly contract: string;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export interface MarketStreamOptions {
  readonly url: string;
  readonly onEvent: (event: MarketEvent) => void;
  readonly onStateChange: (state: "idle" | "connecting" | "open" | "closed") => void;
  readonly socketFactory?: (url: string) => WebSocketLike;
}

export class MarketStream {
  readonly #options: MarketStreamOptions;
  #socket: WebSocketLike | null = null;
  #contracts = new Set<string>();
  #state: "idle" | "connecting" | "open" | "closed" = "idle";

  constructor(options: MarketStreamOptions) {
    this.#options = options;
  }

  get state(): "idle" | "connecting" | "open" | "closed" {
    return this.#state;
  }

  get contracts(): string[] {
    return [...this.#contracts].sort();
  }

  connect(): void {
    if (this.#socket !== null) {
      return;
    }
    this.#setState("connecting");
    const factory =
      this.#options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = factory(this.#options.url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#setState("open");
      if (this.#contracts.size > 0) {
        this.#sendSubscribe();
      }
    };
    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = message.type;
      if (typeof type !== "string" || !type.startsWith("market.")) {
        return;
      }
      const contract = message.contract;
      if (typeof contract !== "string") {
        return;
      }
      this.#options.onEvent({
        type: type as MarketEventType,
        contract,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
        data: (message.data ?? {}) as Record<string, unknown>,
      });
    };
    socket.onclose = () => {
      this.#socket = null;
      this.#setState("closed");
    };
    socket.onerror = () => {
      /* ditangani onclose */
    };
  }

  /**
   * Ganti daftar kontrak yang dilanggan. HANYA kontrak yang terlihat/dipilih
   * yang dilanggan — jangan seluruh universe.
   */
  setContracts(contracts: readonly string[]): void {
    const next = new Set(contracts);
    const changed =
      next.size !== this.#contracts.size || [...next].some((contract) => !this.#contracts.has(contract));
    if (!changed) {
      return;
    }
    const removed = [...this.#contracts].filter((contract) => !next.has(contract));
    this.#contracts = next;
    if (this.#socket === null) {
      return;
    }
    if (removed.length > 0) {
      this.#socket.send(JSON.stringify({ op: "unsubscribe_market" }));
    }
    if (next.size > 0) {
      this.#sendSubscribe();
    }
  }

  #sendSubscribe(): void {
    this.#socket?.send(
      JSON.stringify({ op: "subscribe_market", contracts: [...this.#contracts].sort() }),
    );
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#setState("closed");
  }

  #setState(state: "idle" | "connecting" | "open" | "closed"): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#options.onStateChange(state);
  }
}
