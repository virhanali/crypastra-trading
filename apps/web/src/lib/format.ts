/**
 * Formatting angka finansial.
 *
 * ATURAN: nilai finansial datang sebagai STRING dari API. Frontend TIDAK
 * melakukan aritmetika akuntansi (itu tugas backend). Modul ini hanya
 * memformat untuk tampilan, dan melakukan penjumlahan/pembulatan tampilan
 * pada skala desimal yang sama supaya tidak memakai float untuk uang.
 *
 * Nilai yang akan DIKIRIM kembali ke API selalu memakai `toApiDecimal()`,
 * tidak pernah string yang sudah diformat.
 */

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value.trim());
}

/** Skala tetap berbasis string (tanpa float) untuk pembulatan tampilan. */
function roundScaled(value: string, decimals: number): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (decimals <= 0) {
    const nextDigit = fraction.charAt(0);
    let rounded = BigInt(whole);
    if (nextDigit >= "5") {
      rounded += 1n;
    }
    return `${negative ? "-" : ""}${rounded.toString()}`;
  }
  const padded = (fraction + "0".repeat(decimals + 1)).slice(0, decimals + 1);
  const keep = padded.slice(0, decimals);
  const nextDigit = padded.charAt(decimals);
  let scaled = BigInt(`${whole}${keep}`);
  if (nextDigit >= "5") {
    scaled += 1n;
  }
  const text = scaled.toString().padStart(decimals + 1, "0");
  const result = `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
  return `${negative ? "-" : ""}${result}`;
}

export function decimalAbs(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** Bulatkan string desimal ke `decimals` (half-up), tetap string. */
export function roundDecimal(value: string, decimals: number): string {
  return isDecimalString(value) ? roundScaled(value.trim(), decimals) : value;
}

/** Bandingkan dua string desimal tanpa float (skala BigInt eksak). -1/0/1. */
export function compareDecimal(left: string, right: string): number {
  const a = toScaledBigInt(left);
  const b = toScaledBigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

const COMPARE_SCALE = 18;

function toScaledBigInt(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const padded = (fraction + "0".repeat(COMPARE_SCALE)).slice(0, COMPARE_SCALE);
  const magnitude = BigInt(`${whole || "0"}${padded}`);
  return negative ? -magnitude : magnitude;
}

/** Apakah string desimal bernilai negatif (bukan nol). */
export function isNegativeDecimal(value: string): boolean {
  if (!isDecimalString(value)) {
    return false;
  }
  return value.trim().startsWith("-") && !/^-0(\.0*)?$/.test(value.trim());
}

export function isZeroDecimal(value: string): boolean {
  return isDecimalString(value) && /^-?0(\.0*)?$/.test(value.trim());
}

/**
 * Tampilan harga: mempertahankan presisi asli (trailing zeros dibuang).
 * Dipakai untuk harga, di mana `0.1` dan `0.10` adalah nilai yang sama dan
 * presisi asli exchange lebih informatif.
 */
export function formatPrice(value: string | null, fallback = "—"): string {
  if (value === null || value === undefined || !isDecimalString(value)) {
    return fallback;
  }
  return groupDecimal(stripTrailingZeros(value.trim()));
}

/**
 * Tampilan dengan jumlah desimal TETAP.
 *
 * Dipakai untuk KOLOM finansial (saldo, margin, PnL, fee, rate) supaya lebar
 * kolom tidak "menari" saat nilai berubah — konsisten dengan aturan tabular.
 */
export function formatFixed(value: string | null, decimals: number, fallback = "—"): string {
  if (value === null || value === undefined || !isDecimalString(value)) {
    return fallback;
  }
  return groupDecimal(roundDecimal(value.trim(), decimals));
}

/** Tampilan uang dengan desimal tetap (kolom saldo). */
export function formatMoney(value: string | null, decimals = 2, fallback = "—"): string {
  return formatFixed(value, decimals, fallback);
}

/** Pemisah ribuan pada bagian bulat; bagian pecahan dipertahankan apa adanya. */
function groupDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const result = fraction === undefined || fraction === "" ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${result}` : result;
}

/** Untuk input yang DIKIRIM ke API: angka polos, tanpa pemisah. */
export function toApiDecimal(value: string): string {
  return value.trim().replace(/,/g, "");
}

export function stripTrailingZeros(value: string): string {
  if (!value.includes(".")) {
    return value;
  }
  return value.replace(/\.?0+$/, "");
}

export function formatSigned(value: string | null, decimals = 2, fallback = "—"): string {
  if (value === null || value === undefined || !isDecimalString(value)) {
    return fallback;
  }
  const rounded = roundDecimal(value.trim(), decimals);
  const text = formatFixed(rounded, decimals);
  if (isZeroDecimal(rounded)) {
    return text;
  }
  return isNegativeDecimal(rounded) ? text : `+${text}`;
}

/** Arah finansial untuk pewarnaan; netral bila nol/tidak diketahui. */
export function financialTone(value: string | null): "positive" | "negative" | "neutral" {
  if (value === null || !isDecimalString(value)) {
    return "neutral";
  }
  if (isZeroDecimal(value)) {
    return "neutral";
  }
  return isNegativeDecimal(value) ? "negative" : "positive";
}

export function formatInteger(value: string | null, fallback = "—"): string {
  if (value === null || !isDecimalString(value)) {
    return fallback;
  }
  return stripTrailingZeros(value.trim());
}

export function formatPercent(value: string | null, decimals = 4, fallback = "—"): string {
  if (value === null || !isDecimalString(value)) {
    return fallback;
  }
  const scaled = multiplyBy100(value.trim(), decimals);
  // Desimal tetap: rate adalah kolom finansial yang dibandingkan antar baris.
  return `${formatFixed(scaled, decimals)}%`;
}

/** ×100 tanpa float: geser koma desimal. */
function multiplyBy100(value: string, decimals: number): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const shifted = `${whole}${fraction.slice(0, 2)}`;
  const rest = fraction.slice(2);
  const result = `${stripTrailingZeros(shifted)}${rest.length > 0 ? `.${rest}` : ""}`;
  return roundDecimal(`${negative ? "-" : ""}${result}`, decimals);
}

export function formatTime(ms: number | null, withDate = false): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "—";
  }
  const date = new Date(ms);
  const time = date.toLocaleTimeString("en-GB", { hour12: false });
  return withDate ? `${date.toLocaleDateString("en-CA")} ${time}` : time;
}

export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m`;
}
