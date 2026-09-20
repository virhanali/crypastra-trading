import type { DomainEventDto } from "../api/types.js";

/**
 * Stream peristiwa domain (durable).
 *
 * Kontrak server (docs/REALTIME.md):
 *  - amplop ber-`seq` global monoton;
 *  - pengiriman AT-LEAST-ONCE → klien WAJIB dedupe berdasarkan `seq`;
 *  - resume dengan `afterSeq`;
 *  - server dapat memutus klien lambat dengan kode 1013 + `resync_required`.
 *
 * Kelas ini hanya mengurus protokol + dedupe. Ia tidak menyimpan state akun;
 * pemanggil yang memutuskan apa yang dilakukan terhadap event.
 */

export interface DomainStreamOptions {
  readonly url: string;
  readonly accountId: string;
  readonly afterSeq: number;
  readonly onEvent: (event: DomainEventDto) => void;
  /** Dipanggil saat server meminta resync (klien harus ambil snapshot baru). */
  readonly onResyncRequired: (reason: string) => void;
  readonly onStateChange: (state: DomainStreamState) => void;
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly nowMs?: () => number;
}

export type DomainStreamState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Bagian WebSocket yang dipakai, agar dapat diganti palsu di test. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}


export class DomainStream {
  readonly #options: DomainStreamOptions;
  #socket: WebSocketLike | null = null;
  #state: DomainStreamState = "idle";
  /** `seq` tertinggi yang sudah diserahkan — inti dedupe at-least-once. */
  #lastSeq: number;
  #closedByCaller = false;

  constructor(options: DomainStreamOptions) {
    this.#options = options;
    this.#lastSeq = options.afterSeq;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get state(): DomainStreamState {
    return this.#state;
  }

  connect(): void {
    if (this.#socket !== null) {
      return;
    }
    this.#closedByCaller = false;
    this.#setState("connecting");
    const factory =
      this.#options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = factory(this.#options.url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#setState("open");
      // Resume SELALU dari seq terakhir yang sudah diserahkan.
      socket.send(
        JSON.stringify({ op: "subscribe", accountId: this.#options.accountId, afterSeq: this.#lastSeq }),
      );
    };

    socket.onmessage = (event) => this.#handleMessage(event.data);

    socket.onclose = (event) => {
      this.#socket = null;
      if (this.#closedByCaller) {
        this.#setState("closed");
        return;
      }
      if (event?.code === 1013) {
        // Server meminta resync: jangan sekadar menyambung ulang.
        this.#options.onResyncRequired(event.reason ?? "resync_required");
        this.#setState("closed");
        return;
      }
      this.#setState("reconnecting");
      this.#options.onResyncRequired("reconnecting");
    };

    socket.onerror = () => {
      // Detail error tidak berguna di UI; state perubahan ditangani onclose.
    };
  }

  /** Perbarui titik resume (mis. setelah snapshot baru). */
  resumeFrom(seq: number): void {
    if (seq > this.#lastSeq) {
      this.#lastSeq = seq;
    }
  }

  close(): void {
    this.#closedByCaller = true;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#setState("closed");
  }

  #setState(state: DomainStreamState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#options.onStateChange(state);
  }

  #handleMessage(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    // Ack/resume bukan event domain.
    if (typeof message.op === "string") {
      if (message.op === "error" && message.code === "VALIDATION_ERROR") {
        return;
      }
      return;
    }

    const seq = message.seq;
    if (typeof seq !== "number") {
      return;
    }
    // DEDUPE: at-least-once berarti `seq` sama bisa datang dua kali.
    if (seq <= this.#lastSeq) {
      return;
    }
    this.#lastSeq = seq;
    this.#options.onEvent(message as unknown as DomainEventDto);
  }
}
