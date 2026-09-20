import { Decimal, MONEY_DP } from "@crypastra/core";

/**
 * Konversi nilai finansial antara domain (Decimal) dan SQLite (TEXT).
 *
 * Ini SATU-SATUNYA tempat konversi uang boleh terjadi. Semua repository
 * memakai fungsi di sini; tidak ada repository yang memanggil `toFixed` atau
 * `new Decimal` sendiri untuk uang.
 *
 * Dua kelas representasi:
 *
 *  1. `encodeMoney` / `decodeMoney` — nilai akuntansi (saldo, margin, PnL, fee,
 *     funding). Skala kanonik TETAP 8 dp (ACCOUNTING.md §1). Pembulatan eksplisit
 *     ke 8 dp terjadi saat menulis, jadi nilai tersimpan selalu kanonik.
 *
 *  2. `encodeDecimalString` — desimal non-akuntansi (harga, rate, spesifikasi
 *     kontrak) yang di domain tetap berupa string (tipe market data core).
 *     Nilai dipertahankan apa adanya, hanya divalidasi dan dinormalkan ke bentuk
 *     desimal polos (tanpa notasi eksponen). Tidak ada pembulatan ke 8 dp karena
 *     probe Gate.io menemukan `order_price_round` sampai 11 dp.
 *
 * Tidak ada `Number`, `parseFloat`, atau `parseInt` di jalur ini.
 */

export function encodeMoney(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP).toFixed(MONEY_DP);
}

export function decodeMoney(value: string): Decimal {
  return new Decimal(value);
}

export function encodeDecimalString(value: string | Decimal): string {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  if (!decimal.isFinite()) {
    throw new Error(`Nilai desimal tidak berhingga: ${value}`);
  }
  const text = decimal.toString();
  if (/[eE]/.test(text)) {
    throw new Error(
      `Nilai desimal tidak boleh dalam notasi eksponen: ${value}. ` +
        "Naikkan toExpNeg/toExpPos di packages/core/src/money.ts.",
    );
  }
  return text;
}

export function decodeDecimalString(value: string): string {
  return value;
}

/**
 * Baca desimal non-akuntansi (harga, rate, spec kontrak) kembali menjadi
 * `Decimal` tanpa pembulatan. Pasangan `encodeDecimalString` untuk kolom yang
 * disimpan eksak.
 */
export function decodeExact(value: string): Decimal {
  return new Decimal(value);
}
