import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTING_SCALE,
  Decimal,
  quantizeLiquidationPrice,
  quantizeToTick,
  roundAvailableDown,
  roundFeeAmount,
  roundMarginUp,
  roundMoneyNeutral,
  scaleOf,
} from "../packages/core/src/index.js";

const EXCHANGE_DIR = join(import.meta.dir, "..", "packages", "core", "src", "exchange");

function exchangeModules(): string[] {
  return readdirSync(EXCHANGE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(EXCHANGE_DIR, name));
}

function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*/")
      );
    })
    .join("\n");
}

describe("9. kebijakan pembulatan terpusat", () => {
  test("skala akuntansi tetap 8 dp", () => {
    expect(ACCOUNTING_SCALE).toBe(8);
  });

  test("skala uang: netral HALF_UP", () => {
    expect(roundMoneyNeutral("0.000000005").toString()).toBe("0.00000001");
    expect(roundMoneyNeutral("0.000000004").toString()).toBe("0");
  });

  test("fee: biaya dibulatkan ke atas, rebate dibulatkan ke bawah magnitudonya", () => {
    // biaya → trader membayar lebih
    expect(roundFeeAmount("0.0000000375").toString()).toBe("0.00000004");
    // rebate → trader menerima lebih sedikit (magnitudo mengecil)
    expect(roundFeeAmount("-0.0000000375").toString()).toBe("-0.00000003");
    // nilai eksak tidak berubah
    expect(roundFeeAmount("0.006").toString()).toBe("0.006");
    expect(roundFeeAmount("-0.0008").toString()).toBe("-0.0008");
  });

  test("fee: trader tidak pernah lebih baik dari nilai eksak (kedua arah)", () => {
    const cases = ["0.0000000375", "-0.0000000375", "0.123456785", "-0.123456785"];
    for (const raw of cases) {
      const rounded = roundFeeAmount(raw);
      const exact = new Decimal(raw);
      // `roundFeeAmount` = CEIL pada amount bertanda (positif = biaya), sehingga
      // hasilnya selalu >= eksak: biaya jadi lebih mahal, rebate jadi lebih kecil.
      expect(rounded.greaterThanOrEqualTo(exact)).toBe(true);
    }
  });

  test("margin dibulatkan KE ATAS dan tidak pernah negatif", () => {
    expect(roundMarginUp("2.666666666").toString()).toBe("2.66666667");
    expect(roundMarginUp("0.8").toString()).toBe("0.8");
    expect(roundMarginUp("0").toString()).toBe("0");
  });

  test("available balance dibulatkan KE BAWAH", () => {
    expect(roundAvailableDown("85.123456789").toString()).toBe("85.12345678");
    expect(roundAvailableDown("-70.000000001").toString()).toBe("-70.00000001");
  });

  test("harga TIDAK memakai skala 8 dp: tick 11 dp dipertahankan", () => {
    const price = quantizeToTick("0.0000000000123", "0.00000000001");
    expect(scaleOf(new Decimal("0.00000000001"))).toBe(11);
    expect(price.toString()).toBe("0.00000000001");
  });

  test("kuantisasi tick harga bulat", () => {
    expect(quantizeToTick("80000.04", "0.1").toString()).toBe("80000");
    expect(quantizeToTick("80000.05", "0.1").toString()).toBe("80000.1");
    expect(quantizeToTick("2.505", "0.01").toString()).toBe("2.51");
  });

  test("tick tidak valid ditolak", () => {
    expect(() => quantizeToTick("100", "0")).toThrow();
    expect(() => quantizeToTick("100", "-1")).toThrow();
  });

  test("harga likuidasi dikuantisasi ke sisi yang memicu lebih awal", () => {
    // LONG: dibulatkan ke atas (mendekati entry)
    expect(quantizeLiquidationPrice("72240.0001", "long", "1").toString()).toBe("72241");
    // SHORT: dibulatkan ke bawah (mendekati entry)
    expect(quantizeLiquidationPrice("80160.9999", "short", "1").toString()).toBe("80160");
  });
});

describe("9b. tidak ada pembulatan liar di modul exchange", () => {
  test("hanya rounding.ts yang boleh memakai primitif pembulatan", () => {
    const offenders: string[] = [];
    for (const file of exchangeModules()) {
      if (file.endsWith("rounding.ts")) {
        continue;
      }
      const source = stripCommentLines(readFileSync(file, "utf8"));
      for (const pattern of [
        /\.toDecimalPlaces\s*\(/,
        /Decimal\.ROUND_/,
        /\.toNumber\s*\(/,
        /\bparseFloat\b/,
        /\bparseInt\b/,
        /\bNumber\s*\(/,
      ]) {
        if (pattern.test(source)) {
          offenders.push(`${file.replace(EXCHANGE_DIR, "exchange")} cocok ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
