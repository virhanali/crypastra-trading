import { Decimal } from "../money.js";
import type { ContractSpec } from "../contract.js";
import { directionSign, notionalValueFor } from "./contract-math.js";
import { roundMoneyNeutral } from "./rounding.js";
import type { Direction } from "./types.js";

/**
 * KEBIJAKAN funding runtime (bukan rumusnya — rumus ada di `fee.ts`).
 *
 * A3 BELUM terverifikasi: perilaku funding Gate.io (dasar harga, prorata, waktu
 * pasti penerapan) belum dikonfirmasi. Kebijakan di bawah adalah aturan SIMULATOR
 * yang deterministik dan tidak boleh disebut sebagai paritas Gate.io.
 *
 * Kebijakan simulator yang dipilih:
 *  1. Funding diterapkan SEKALI per `fundingTimestampMs` per posisi.
 *  2. Posisi dikenakan funding untuk timestamp T bila `openedAtMs <= T`.
 *     Posisi yang dibuka TEPAT pada T tetap dikenakan (inklusif).
 *  3. Hanya posisi berstatus `open` yang dikenakan. Posisi yang ditutup sebelum
 *     ATAU TEPAT pada T tidak dikenakan, karena posisinya sudah tidak `open`
 *     saat snapshot diproses.
 *  4. Dasar notional memakai MARK PRICE dari snapshot (bukan entry, bukan last).
 *  5. Tidak ada prorata: biaya penuh untuk periode tersebut.
 */

export interface FundingDueInput {
  readonly positionOpenedAtMs: number;
  readonly fundingTimestampMs: number;
}

/** Apakah posisi ini terkena funding pada timestamp tersebut. */
export function fundingDueFor(input: FundingDueInput): boolean {
  return input.positionOpenedAtMs <= input.fundingTimestampMs;
}

/** Kunci idempotensi funding: satu efek per (contract, timestamp, posisi). */
export function fundingIdempotencyKey(
  contract: string,
  fundingTimestampMs: number,
  positionId: string,
): string {
  return `funding:${contract}:${fundingTimestampMs}:${positionId}`;
}

/**
 * Kunci idempotensi untuk satu EFEK dari penutupan paksa.
 *
 * Tidak memuat timestamp: satu posisi hanya bisa ditutup sekali, jadi
 * (posisi, alasan, efek) sudah unik dan stabil terhadap pengulangan.
 */
export function settlementIdempotencyKey(
  reason: string,
  positionId: string,
  effect: string,
): string {
  return `settle:${positionId}:${reason}:${effect}`;
}

/**
 * Beban funding lengkap (memerlukan mark price). Dipisah agar pemanggil harus
 * memasok mark price secara eksplisit — funding TIDAK boleh memakai last price.
 */
export function fundingPaymentAtMark(input: {
  spec: ContractSpec;
  direction: Direction;
  size: number;
  markPrice: Decimal.Value;
  rate: Decimal.Value;
}): Decimal {
  const notional = notionalValueFor(input.spec, input.size, input.markPrice);
  return roundMoneyNeutral(notional.times(input.rate).times(directionSign(input.direction)));
}
