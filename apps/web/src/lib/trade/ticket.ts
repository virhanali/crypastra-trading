import type { OrderIntent } from "./intent.js";

/**
 * Mesin keadaan tiket order (murni, dapat diuji).
 *
 * Inti kebenaran idempotensi ada di BACKEND; modul ini hanya memastikan klien
 * tidak pernah membuat perintah baru untuk aksi logis yang sama.
 *
 * Keadaan pengiriman (docs/design/TERMINAL.md):
 *   idle → submitting → succeeded
 *                     → definitively_failed   (backend menolak; aman mengubah payload)
 *                     → outcome_uncertain     (timeout/putus setelah kirim; JANGAN bilang gagal)
 *
 * Aturan penting: begitu `submitting`, payload DIBEKUKAN (`frozen`). Retry memakai
 * payload dan commandId yang sama, sehingga suntingan field tidak dapat mengubah
 * perintah yang statusnya belum pasti.
 */

export type SubmissionState =
  | "idle"
  | "submitting"
  | "succeeded"
  | "definitively_failed"
  | "outcome_uncertain";

export interface FrozenRequest {
  readonly commandId: string;
  readonly intent: OrderIntent;
}

export interface TicketState {
  readonly state: SubmissionState;
  readonly frozen: FrozenRequest | null;
  /** Aksi logis yang sedang ditangani (kunci CommandBook). */
  readonly pendingKey: string | null;
  readonly message: string | null;
  readonly errorCode: string | null;
}

export const initialTicketState: TicketState = {
  state: "idle",
  frozen: null,
  pendingKey: null,
  message: null,
  errorCode: null,
};

export interface SubmitStart {
  readonly commandId: string;
  readonly actionKey: string;
  readonly intent: OrderIntent;
}

/** Mulai mengirim: bekukan payload. Dipanggil HANYA jika belum ada yang tertunda. */
export function beginSubmit(state: TicketState, start: SubmitStart): TicketState {
  if (state.state === "submitting" || state.state === "outcome_uncertain") {
    // Sudah ada perintah yang belum pasti: tidak boleh menimpa payload beku.
    return state;
  }
  return {
    state: "submitting",
    frozen: { commandId: start.commandId, intent: start.intent },
    pendingKey: start.actionKey,
    message: null,
    errorCode: null,
  };
}

export function submitSucceeded(): TicketState {
  return { state: "succeeded", frozen: null, pendingKey: null, message: null, errorCode: null };
}

/** Backend menolak dengan pasti (4xx bermakna): payload boleh diubah. */
export function submitDefinitivelyFailed(errorCode: string, message: string): TicketState {
  return { state: "definitively_failed", frozen: null, pendingKey: null, message, errorCode };
}

/**
 * Hasil TIDAK PASTI (timeout/jaringan putus setelah kirim).
 * Payload yang dibekukan DIPERTAHANKAN supaya retry memakai perintah yang sama
 * persis — suntingan field tidak boleh mengubah perintah yang belum pasti.
 */
export function submitUncertain(state: TicketState, message: string): TicketState {
  return {
    state: "outcome_uncertain",
    frozen: state.frozen,
    pendingKey: state.pendingKey,
    message,
    errorCode: null,
  };
}

/** Apakah boleh menekan submit lagi (retry) — hanya dengan payload beku. */
export function canRetry(state: TicketState): boolean {
  return state.state === "outcome_uncertain" && state.frozen !== null;
}

/** Manusia membatalkan aksi yang belum pasti dan memulai yang baru. */
export function abandon(): TicketState {
  return { ...initialTicketState };
}

export function isBusy(state: TicketState): boolean {
  return state.state === "submitting" || state.state === "outcome_uncertain";
}

/** Teks status untuk UI. Tidak pernah berbohong tentang kegagalan. */
export function statusText(state: TicketState): string | null {
  switch (state.state) {
    case "submitting":
      return "Mengirim order PAPER…";
    case "outcome_uncertain":
      return "Memeriksa status order…";
    case "succeeded":
      return "Order PAPER diterima";
    case "definitively_failed":
      return state.message === null ? "Order ditolak" : `Order ditolak — ${state.message}`;
    default:
      return null;
  }
}
