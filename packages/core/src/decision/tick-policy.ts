import { Decimal } from "../money.js";
import type { Direction } from "../exchange/types.js";

/**
 * Kebijakan pembulatan harga protektif (Phase 10).
 *
 * Pembulatan TIDAK netral: arahnya dipilih supaya rencana tidak pernah
 * MELEBIHI risiko yang direncanakan dan tidak pernah MELEBIHKAN reward.
 *
 *  - Stop loss LONG  → dibulatkan KE ATAS (mendekati entry): stop terpicu lebih
 *    awal, jarak stop aktual <= jarak terencana → rugi aktual tidak lebih besar.
 *  - Stop loss SHORT → dibulatkan KE BAWAH (mendekati entry): sama alasannya.
 *  - Take profit LONG  → dibulatkan KE BAWAH (mendekati entry): reward aktual
 *    <= reward terencana, tidak membesar-besarkan target.
 *  - Take profit SHORT → dibulatkan KE ATAS (mendekati entry): sama alasannya.
 *
 * Dengan kata lain: stop selalu dibulatkan menjauh dari risiko, target selalu
 * dibulatkan menjauh dari harapan. Ukuran posisi kemudian dihitung dari jarak
 * stop HASIL PEMBULATAN, bukan dari nilai teoretis.
 */
export type ProtectivePriceKind = "stop" | "target";

export function roundProtectivePrice(
  price: Decimal.Value,
  kind: ProtectivePriceKind,
  direction: Direction,
  tick: Decimal.Value,
): Decimal {
  const mode =
    kind === "stop"
      ? direction === "long"
        ? Decimal.ROUND_CEIL
        : Decimal.ROUND_FLOOR
      : direction === "long"
        ? Decimal.ROUND_FLOOR
        : Decimal.ROUND_CEIL;

  const t = new Decimal(tick);
  const steps = new Decimal(price).div(t).toDecimalPlaces(0, mode);
  const scale = t.decimalPlaces();
  return steps.times(t).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}
