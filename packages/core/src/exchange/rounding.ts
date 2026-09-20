import { InvalidContractSpecError } from "../errors.js";
import { Decimal, MONEY_DP, RATE_DP } from "../money.js";

/**
 * Kebijakan pembulatan TERPUSAT untuk seluruh matematika exchange.
 *
 * Aturan: modul exchange lain tidak boleh memanggil `toDecimalPlaces` sendiri.
 * Semua pembulatan lewat fungsi bernama di sini, supaya semantik ekonominya
 * eksplisit dan bisa diaudit di satu tempat. Ditegakkan
 * `tests/phase2-rounding.test.ts`.
 *
 * Skala:
 *  - UANG (saldo, margin, PnL, fee, funding) = 8 dp. Ini kontrak akuntansi yang
 *    disetujui di ACCOUNTING.md §1, BUKAN nilai eksak Gate.io.
 *  - HARGA = tidak punya skala tetap. Harga dikuantisasi ke tick kontrak
 *    (`order_price_round` / `mark_price_round`), yang bisa sampai 11 dp
 *    (SATS_USDT). Jangan pernah asumsikan 8 dp untuk harga.
 */

/** Skala uang akuntansi: 8 dp. */
export const ACCOUNTING_SCALE = MONEY_DP;

/**
 * Netral: pembulatan setengah ke atas. Dipakai untuk besaran yang tidak boleh
 * bias ke salah satu pihak (PnL realisasi, funding, rasio margin).
 */
export function roundMoneyNeutral(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

/**
 * Fee, didefinisikan lewat EFEK EKONOMI pada AMOUNT BERTANDA
 * (positif = trader membayar, negatif = rebate), bukan lewat nama mode Decimal.
 *
 * Aturan: trader tidak pernah mendapat hasil lebih baik dari nilai eksak.
 * `ROUND_CEIL` pada amount bertanda menghasilkan keduanya sekaligus:
 *   - biaya  (+0.0000000375) →  0.00000004  → trader MEMBAYAR lebih
 *   - rebate (−0.000000805)  → −0.00000080  → trader MENERIMA lebih sedikit
 *
 * Kenapa bukan `ROUND_FLOOR`? Karena floor bekerja pada ruang DELTA DOMPET
 * (yang bertanda terbalik dari amount: delta = −amount), sehingga floor akan
 * memberi trader biaya lebih murah dan rebate lebih besar — kebalikan dari
 * maksudnya. Fungsi ini sengaja diberi nama "Amount" untuk mencegah tertukar.
 *
 * Rebate TIDAK di-clamp ke nol; nilai negatifnya tetap terwakili.
 */
export function roundFeeAmount(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_CEIL);
}

/**
 * Margin: dibulatkan ke atas (menuju +∞). Margin selalu ≥ 0, jadi arah ini
 * tidak ambigu: trader menaruh margin tidak kurang dari nilai eksak.
 */
export function roundMarginUp(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_CEIL);
}

/**
 * Saldo tersedia: dibulatkan ke bawah (menuju −∞) supaya trader tidak bisa
 * membelanjakan lebih dari yang tersedia.
 */
export function roundAvailableDown(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_FLOOR);
}

/**
 * Pelepasan margin posisi saat posisi diperkecil: dibulatkan KE BAWAH (menuju −∞).
 *
 * Konservatif dan menjaga konservasi: margin yang dilepas tidak pernah melebihi
 * porsi proporsionalnya, jadi `used_margin` tidak pernah turun di bawah nilai
 * yang seharusnya. Sisa pembulatan tetap terkunci di posisi sampai posisi
 * ditutup penuh, di mana SELURUH margin sisa dilepas.
 */
export function roundMarginReleaseDown(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_FLOOR);
}

/** Jumlah desimal signifikan dari sebuah nilai desimal (untuk skala tick). */
export function scaleOf(value: Decimal): number {
  const text = value.toString();
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Skalakan rate ke RATE_DP. Ini pembulatan presisi representasi, bukan
 * pembulatan uang: rate dipakai sebagai pengali, bukan disimpan sebagai saldo.
 */
export function scaleRate(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(RATE_DP, Decimal.ROUND_HALF_UP);
}

/**
 * Jumlah kontrak bulat dari sebuah Decimal, dibulatkan KE BAWAH.
 * `size` adalah cacah kontrak (INTEGER di DB), BUKAN nilai uang — sehingga
 * konversi ke `number` di sini sah dan tidak melanggar aturan anti-float.
 */
/**
 * Ukuran kontrak DESIMAL → number, dibulatkan KE BAWAH pada `dp` desimal.
 *
 * Kontrak dengan `enable_decimal=true` tidak mengekspos langkah ukuran, jadi
 * Phase 10 memakai skala akuntansi (8 dp) sebagai presisi ukuran paper dan
 * selalu membulatkan ke bawah — ukuran tidak pernah dibesarkan diam-diam
 * (itu akan menaikkan risiko). Konversi ke `number` sengaja terpusat di sini,
 * bukan tersebar di lapisan keputusan.
 */
/**
 * Ukuran kontrak tersimpan (string) → number untuk `ContractSpec`/order.
 *
 * Terpusat di sini supaya lapisan server TIDAK perlu memanggil `Number()`/
 * `toNumber()` sendiri (dilarang oleh guard presisi) dan supaya satu-satunya
 * jalur konversi ukuran tetap di modul presisi.
 */
export function decodeContractSize(value: Decimal.Value): number {
  return toContractCount(value);
}

/**
 * SATU-SATUNYA titik konversi Decimal → number untuk cacah kontrak.
 *
 * Aritmetika ukuran dilakukan dengan `Decimal` (lihat `planLevelConsumption`);
 * `number` hanya dipakai karena tipe domain yang sudah ada (`LevelTake.size`,
 * `OrderRecord.size`, dst.) memakainya. Mengumpulkan konversinya di sini menjaga
 * disiplin "tidak ada aritmetika finansial lewat number".
 */
export function toContractCount(value: Decimal.Value): number {
  return new Decimal(value).toNumber();
}

/**
 * Bentuk tekstual KANONIK sebuah cacah kontrak: `Decimal.toString()` membuang
 * nol di belakang koma, sehingga `"1.50"` dan `"1.500"` menjadi `"1.5"`.
 * Dipakai sebelum fingerprint perintah supaya perbedaan format tidak dianggap
 * perintah berbeda.
 */
export function canonicalContractSize(value: Decimal.Value): string {
  return new Decimal(value).toString();
}

export function floorToDecimalSize(value: Decimal.Value, dp = MONEY_DP): number {
  return new Decimal(value).toDecimalPlaces(dp, Decimal.ROUND_FLOOR).toNumber();
}

export function floorToContractCount(value: Decimal.Value): number {
  return new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_FLOOR).toNumber();
}

function assertPositiveTick(tick: Decimal): void {
  if (!tick.isFinite() || tick.lessThanOrEqualTo(0)) {
    throw new InvalidContractSpecError(`Tick size harus positif berhingga, dapat: ${tick.toString()}`);
  }
}

/**
 * Kuantisasi harga ke tick kontrak. Netral (setengah ke atas), mengikuti
 * konvensi grid harga exchange. Tidak ada skala dp tetap: tick menentukan
 * presisinya (sampai 11 dp pada kontrak seperti SATS_USDT).
 */
export function quantizeToTick(price: Decimal.Value, tick: Decimal.Value): Decimal {
  const t = new Decimal(tick);
  assertPositiveTick(t);
  const steps = new Decimal(price).div(t).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return steps.times(t).toDecimalPlaces(scaleOf(t), Decimal.ROUND_HALF_UP);
}

/**
 * Kuantisasi harga likuidasi ke `mark_price_round`, dibulatkan ke sisi yang
 * MEMICU LEBIH AWAL (konservatif):
 *   - LONG  : liq di bawah entry → dibulatkan ke atas (mendekati entry)
 *   - SHORT : liq di atas entry  → dibulatkan ke bawah (mendekati entry)
 *
 * Harga likuidasi dibandingkan dengan mark price, jadi tick yang dipakai adalah
 * `mark_price_round`, bukan `order_price_round`.
 */
export function quantizeLiquidationPrice(
  price: Decimal.Value,
  direction: "long" | "short",
  markPriceRound: Decimal.Value,
): Decimal {
  const t = new Decimal(markPriceRound);
  assertPositiveTick(t);
  const mode = direction === "long" ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR;
  const steps = new Decimal(price).div(t).toDecimalPlaces(0, mode);
  return steps.times(t).toDecimalPlaces(scaleOf(t), Decimal.ROUND_HALF_UP);
}
