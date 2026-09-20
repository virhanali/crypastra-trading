import { describe, expect, test } from "bun:test";
import {
  compareDecimal,
  financialTone,
  formatInteger,
  formatMoney,
  formatPercent,
  formatPrice,
  formatSigned,
  isDecimalString,
  isNegativeDecimal,
  isZeroDecimal,
  roundDecimal,
  stripTrailingZeros,
  toApiDecimal,
} from "../apps/web/src/lib/format.js";

describe("format: penanganan string finansial", () => {
  test("nilai tidak tersedia ditampilkan sebagai '—', bukan 0", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatMoney(null)).toBe("—");
    expect(formatPrice("bukan-angka")).toBe("—");
    expect(formatInteger(null)).toBe("—");
  });

  test("string desimal dikenali; number BUKAN string finansial", () => {
    expect(isDecimalString("1000.00000000")).toBe(true);
    expect(isDecimalString("-0.0001")).toBe(true);
    expect(isDecimalString(1000)).toBe(false);
    expect(isDecimalString("1e3")).toBe(false);
  });

  test("tidak pernah kehilangan presisi saat menampilkan", () => {
    expect(formatPrice("80445.79000000")).toBe("80,445.79");
    expect(formatPrice("0.00000001")).toBe("0.00000001");
    expect(formatPrice("0.00000000001")).toBe("0.00000000001");
    expect(formatInteger("12000000.00000000")).toBe("12000000");
  });

  test("pembulatan tampilan memakai skala string, bukan float", () => {
    expect(roundDecimal("0.005", 2)).toBe("0.01");
    expect(roundDecimal("0.004", 2)).toBe("0.00");
    expect(roundDecimal("123456789.12345678", 4)).toBe("123456789.1235");
    expect(roundDecimal("-0.005", 2)).toBe("-0.01");
  });

  test("perbandingan desimal eksak lintas magnitudo", () => {
    expect(compareDecimal("9", "10")).toBe(-1);
    expect(compareDecimal("100", "99")).toBe(1);
    expect(compareDecimal("0.1", "0.10")).toBe(0);
    expect(compareDecimal("-5", "-4")).toBe(-1);
    expect(compareDecimal("0.00000000001", "0.00000000002")).toBe(-1);
  });

  test("tanda dan nol dikenali", () => {
    expect(isNegativeDecimal("-0.0001")).toBe(true);
    expect(isNegativeDecimal("0")).toBe(false);
    expect(isNegativeDecimal("-0.0000")).toBe(false);
    expect(isZeroDecimal("0.00000000")).toBe(true);
    expect(isZeroDecimal("-0.0")).toBe(true);
  });

  test("tone finansial: positif/negatif/netral", () => {
    expect(financialTone("0.10000000")).toBe("positive");
    expect(financialTone("-0.1")).toBe("negative");
    expect(financialTone("0.00000000")).toBe("neutral");
    expect(financialTone(null)).toBe("neutral");
  });

  test("nilai bertanda selalu menampilkan tanda eksplisit", () => {
    expect(formatSigned("0.10000000", 2)).toBe("+0.10");
    expect(formatSigned("-0.10000000", 2)).toBe("-0.10");
    expect(formatSigned("0.00000000", 2)).toBe("0.00");
  });

  test("rate ditampilkan sebagai persen tanpa float", () => {
    // 0.0001 → 0.01%
    expect(formatPercent("0.0001", 4)).toBe("0.0100%");
    expect(formatPercent("-0.000054", 4)).toBe("-0.0054%");
    expect(formatPercent(null)).toBe("—");
  });

  test("kolom finansial memakai desimal TETAP agar lebar kolom stabil", () => {
    expect(formatMoney("1000", 2)).toBe("1,000.00");
    expect(formatMoney("0.1", 8)).toBe("0.10000000");
    expect(formatMoney("-0.0001", 8)).toBe("-0.00010000");
  });

  test("nilai yang dikirim ke API tidak pernah berisi format tampilan", () => {
    expect(toApiDecimal("1,000.50")).toBe("1000.50");
    expect(toApiDecimal(" 250 ")).toBe("250");
    // Hasil format (dengan pemisah ribuan) dibersihkan sebelum dikirim.
    expect(formatMoney("1000", 2)).toBe("1,000.00");
    expect(toApiDecimal(formatMoney("1000", 2))).toBe("1000.00");
  });

  test("trailing zeros dibuang hanya untuk tampilan", () => {
    expect(stripTrailingZeros("1000.00000000")).toBe("1000");
    expect(stripTrailingZeros("0.10000000")).toBe("0.1");
    expect(stripTrailingZeros("1000")).toBe("1000");
  });
});
