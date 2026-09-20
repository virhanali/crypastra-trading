import { InvalidOrderError, InvalidPriceError } from "../errors.js";
import { Decimal } from "../money.js";
import type { Direction } from "./types.js";

/**
 * Evaluasi trigger TP/SL. Murni: TIDAK membaca market state.
 *
 * Pemanggil menentukan `observedPrice`. Menurut arsitektur (ADR 0003) aplikasi
 * memberi mark price, tapi fungsi ini hanya mengevaluasi harga yang diberikan.
 */

export type TriggerKind = "take_profit" | "stop_loss";

export type TpSlTrigger = "tp" | "sl" | null;

export interface TriggerInput {
  /** Arah posisi, bukan sisi order. LONG/SHORT menentukan arah trigger. */
  readonly direction: Direction;
  readonly kind: TriggerKind;
  readonly triggerPrice: Decimal.Value;
  readonly observedPrice: Decimal.Value;
}

function assertTriggerPrice(value: Decimal.Value): Decimal {
  const price = new Decimal(value);
  if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
    throw new InvalidPriceError(`Harga trigger harus positif berhingga, dapat: ${String(value)}`);
  }
  return price;
}

function assertObservedPrice(value: Decimal.Value): Decimal {
  const price = new Decimal(value);
  if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
    throw new InvalidPriceError(`Harga pengamatan harus positif berhingga, dapat: ${String(value)}`);
  }
  return price;
}

/**
 * Apakah trigger tercapai pada harga pengamatan.
 *
 *   LONG  take_profit: observed ≥ trigger
 *   LONG  stop_loss  : observed ≤ trigger
 *   SHORT take_profit: observed ≤ trigger
 *   SHORT stop_loss  : observed ≥ trigger
 *
 * Perbandingan INKLUSIF pada kesetaraan (`≥`/`≤`).
 */
export function triggerReached(input: TriggerInput): boolean {
  const trigger = assertTriggerPrice(input.triggerPrice);
  const observed = assertObservedPrice(input.observedPrice);

  switch (input.direction) {
    case "long":
      return input.kind === "take_profit"
        ? observed.greaterThanOrEqualTo(trigger)
        : observed.lessThanOrEqualTo(trigger);
    case "short":
      return input.kind === "take_profit"
        ? observed.lessThanOrEqualTo(trigger)
        : observed.greaterThanOrEqualTo(trigger);
    default:
      throw new InvalidOrderError(`Arah posisi tidak dikenal: ${String(input.direction)}`);
  }
}

export interface TpSlState {
  readonly tpPrice: string | null;
  readonly slPrice: string | null;
}

/**
 * Trigger TP/SL pada satu harga pengamatan. Bila TP dan SL sama-sama terpenuhi
 * dalam satu tick (gap), SL menang — keputusan konservatif (ACCOUNTING.md §7).
 */
export function evaluateTpSl(
  state: TpSlState,
  direction: Direction,
  observedPrice: Decimal.Value,
): TpSlTrigger {
  const slHit =
    state.slPrice !== null &&
    triggerReached({ direction, kind: "stop_loss", triggerPrice: state.slPrice, observedPrice });
  if (slHit) {
    return "sl";
  }
  const tpHit =
    state.tpPrice !== null &&
    triggerReached({ direction, kind: "take_profit", triggerPrice: state.tpPrice, observedPrice });
  return tpHit ? "tp" : null;
}

/** Evaluasi terpisah tanpa prioritas (untuk audit/UI). */
export function evaluateTpSlBoth(
  state: TpSlState,
  direction: Direction,
  observedPrice: Decimal.Value,
): { readonly tp: boolean; readonly sl: boolean } {
  return {
    tp:
      state.tpPrice !== null &&
      triggerReached({ direction, kind: "take_profit", triggerPrice: state.tpPrice, observedPrice }),
    sl:
      state.slPrice !== null &&
      triggerReached({ direction, kind: "stop_loss", triggerPrice: state.slPrice, observedPrice }),
  };
}
