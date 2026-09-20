import { InvalidOrderError } from "../errors.js";
import { Decimal } from "../money.js";
import { assertValidPrice, assertValidSize, baseQuantityFor } from "./contract-math.js";
import { initialMarginFor } from "./margin.js";
import { pnlFor } from "./pnl.js";
import { roundMarginReleaseDown, toContractCount } from "./rounding.js";
import type { OrderSide, Direction } from "./types.js";
import type { ContractSpec } from "../contract.js";

const ZERO = new Decimal(0);

/**
 * Matematika transisi posisi MURNI (one-way mode). Tidak menyentuh DB/clock.
 *
 * Mode posisi: satu posisi netto per (account, contract). Hedge mode TIDAK
 * didukung (belum dispesifikasikan). Flip arah SELALU direpresentasikan sebagai
 * close penuh + open baru, tidak pernah sebagai posisi berukuran negatif.
 */

export type PositionTransitionKind = "open" | "increase" | "reduce" | "close" | "flip";

export interface PositionSnapshot {
  readonly direction: Direction;
  readonly size: number;
  readonly entryPrice: Decimal.Value;
  readonly initialMargin: Decimal.Value;
  readonly leverage: Decimal.Value;
}

export interface ApplyFillInput {
  readonly spec: ContractSpec;
  readonly leverage: Decimal.Value;
  /** null = belum ada posisi terbuka. */
  readonly existing: PositionSnapshot | null;
  /** Sisi order yang menjadi sumber fill. */
  readonly fillSide: OrderSide;
  readonly fillSize: number;
  readonly fillPrice: Decimal.Value;
}

export interface PositionTransition {
  readonly kind: PositionTransitionKind;
  /** Kontrak yang menutup/mengurangi eksposur lama. */
  readonly closedSize: number;
  /** Kontrak yang membuka/menambah eksposur baru. */
  readonly openedSize: number;
  /** PnL realisasi dari porsi yang ditutup. */
  readonly realizedPnl: Decimal;
  /** Margin yang dilepas dari posisi lama. */
  readonly releasedMargin: Decimal;
  /** Margin yang dibutuhkan untuk eksposur baru. */
  readonly openedMargin: Decimal;
  /** true bila posisi lama tidak menyisakan eksposur. */
  readonly closesOldPosition: boolean;
  /** Keadaan posisi setelah fill; null bila tidak ada eksposur tersisa. */
  readonly result: {
    readonly direction: Direction;
    readonly size: number;
    readonly entryPrice: Decimal;
    readonly initialMargin: Decimal;
  } | null;
}

export function directionForSide(side: OrderSide): Direction {
  if (side === "buy") {
    return "long";
  }
  if (side === "sell") {
    return "short";
  }
  throw new InvalidOrderError(`Sisi order tidak dikenal: ${String(side)}`);
}

/**
 * Rencanakan efek satu fill terhadap posisi.
 *
 * - tanpa posisi            → open
 * - searah                  → increase (entry rata-rata tertimbang, margin ditambah)
 * - berlawanan sebagian     → reduce (PnL realisasi, margin dilepas proporsional)
 * - berlawanan pas         → close (seluruh margin dilepas)
 * - berlawanan lebih besar → flip (close penuh + open sisa)
 *
 * Entry rata-rata dihitung EKSAK (tanpa pembulatan antara):
 *   (qty_lama × entry_lama + qty_fill × harga_fill) / (qty_lama + qty_fill)
 * `entry_price` posisi adalah rata-rata akuntansi, bukan harga yang dapat
 * ditransaksikan, jadi tidak dikuantisasi ke tick.
 */
export function planPositionTransition(input: ApplyFillInput): PositionTransition {
  const { spec, existing, fillSide } = input;
  const fillDirection = directionForSide(fillSide);
  const fillPrice = assertValidPrice(input.fillPrice, "Harga fill");
  assertValidSize(spec, input.fillSize);
  const fillSize = input.fillSize;

  // ── Open ───────────────────────────────────────────────────────────
  if (existing === null || existing.size === 0) {
    const margin = initialMarginFor({ spec, size: fillSize, price: fillPrice, leverage: input.leverage });
    return {
      kind: "open",
      closedSize: 0,
      openedSize: fillSize,
      realizedPnl: ZERO,
      releasedMargin: ZERO,
      openedMargin: margin,
      closesOldPosition: false,
      result: { direction: fillDirection, size: fillSize, entryPrice: fillPrice, initialMargin: margin },
    };
  }

  const existingLeverage = new Decimal(existing.leverage);
  const requestedLeverage = new Decimal(input.leverage);
  if (!existingLeverage.eq(requestedLeverage)) {
    throw new InvalidOrderError(
      `Leverage fill ${requestedLeverage.toString()} berbeda dari leverage posisi ${existingLeverage.toString()} untuk ${spec.contract}; satu posisi tidak boleh mencampur leverage`,
    );
  }

  // ── Increase ───────────────────────────────────────────────────────
  if (existing.direction === fillDirection) {
    const oldQty = baseQuantityFor(spec, existing.size);
    const addQty = baseQuantityFor(spec, fillSize);
    const totalQty = oldQty.plus(addQty);
    const weightedEntry = oldQty
      .times(assertValidPrice(existing.entryPrice, "Harga entry posisi"))
      .plus(addQty.times(fillPrice))
      .div(totalQty);
    const addedMargin = initialMarginFor({ spec, size: fillSize, price: fillPrice, leverage: requestedLeverage });

    return {
      kind: "increase",
      closedSize: 0,
      openedSize: fillSize,
      realizedPnl: ZERO,
      releasedMargin: ZERO,
      openedMargin: addedMargin,
      closesOldPosition: false,
      result: {
        direction: existing.direction,
        // Aritmetika ukuran memakai Decimal supaya cacah kontrak pecahan tetap
        // eksak (mis. 1.25 + 0.5 = 1.75, bukan 1.7500000000000002).
        size: toContractCount(new Decimal(existing.size).plus(fillSize)),
        entryPrice: weightedEntry,
        initialMargin: new Decimal(existing.initialMargin).plus(addedMargin),
      },
    };
  }

  // ── Reduce / close / flip ──────────────────────────────────────────
  const existingSize = new Decimal(existing.size);
  const fillSizeDec = new Decimal(fillSize);
  const closedSizeDec = Decimal.min(existingSize, fillSizeDec);
  const remainingSizeDec = fillSizeDec.minus(closedSizeDec);
  const fullClose = closedSizeDec.eq(existingSize);
  const closedSize = toContractCount(closedSizeDec);

  const realizedPnl = pnlFor(spec, existing.direction, closedSize, existing.entryPrice, fillPrice);

  const oldMargin = new Decimal(existing.initialMargin);
  const releasedMargin = fullClose
    ? oldMargin
    : roundMarginReleaseDown(oldMargin.times(closedSizeDec).div(existingSize));
  const remainingMargin = oldMargin.minus(releasedMargin);

  if (remainingSizeDec.isZero()) {
    return {
      kind: fullClose ? "close" : "reduce",
      closedSize,
      openedSize: 0,
      realizedPnl,
      releasedMargin,
      openedMargin: ZERO,
      closesOldPosition: fullClose,
      result: fullClose
        ? null
        : {
            direction: existing.direction,
            size: toContractCount(existingSize.minus(closedSizeDec)),
            entryPrice: new Decimal(existing.entryPrice),
            initialMargin: remainingMargin,
          },
    };
  }

  // Flip: posisi lama ditutup penuh, sisa fill membuka posisi arah baru.
  const remainingSize = toContractCount(remainingSizeDec);
  const openedMargin = initialMarginFor({
    spec,
    size: remainingSize,
    price: fillPrice,
    leverage: requestedLeverage,
  });

  return {
    kind: "flip",
    closedSize,
    openedSize: remainingSize,
    realizedPnl,
    releasedMargin,
    openedMargin,
    closesOldPosition: true,
    result: {
      direction: fillDirection,
      size: remainingSize,
      entryPrice: fillPrice,
      initialMargin: openedMargin,
    },
  };
}

/**
 * Batasi ukuran fill untuk order `reduce_only` supaya tidak menambah atau
 * membalik posisi. Mengembalikan 0 bila order tidak punya eksposur untuk
 * dikurangi (order akan ditolak oleh pemanggil).
 */
export function reduceOnlySize(input: {
  spec: ContractSpec;
  existing: PositionSnapshot | null;
  fillSide: OrderSide;
  requestedSize: number;
}): number {
  const { existing } = input;
  if (existing === null || existing.size === 0) {
    return 0;
  }
  const closingDirection = directionForSide(input.fillSide);
  if (existing.direction === closingDirection) {
    // Searah posisi = menambah eksposur, bukan mengurangi.
    return 0;
  }
  return toContractCount(Decimal.min(new Decimal(input.requestedSize), new Decimal(existing.size)));
}
