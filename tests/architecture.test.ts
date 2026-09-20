import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Buang baris komentar (termasuk JSDoc) sebelum memindai. String literal pada
 * baris kode TIDAK dibuang, supaya "wss://..." yang ditulis sebagai nilai tetap
 * terdeteksi.
 */
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

describe("disiplin uang", () => {
  test("core tidak memakai parseFloat pada sumber", () => {
    const offenders = listFiles(CORE_SRC)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => readFileSync(file, "utf8").includes("parseFloat"));
    expect(offenders).toEqual([]);
  });

  test("0.1 + 0.2 dengan Decimal = 0.3 (bukti bukan float)", async () => {
    const { Decimal } = await import("../packages/core/src/money.js");
    expect(new Decimal("0.1").plus("0.2").toString()).toBe("0.3");
  });
});

describe("batas domain (ADR 0004)", () => {
  test("core tidak menyebut vendor/I/O apa pun", () => {
    const forbidden = [/gateio/i, /wss:\/\//, /\bfastify\b/, /\bdrizzle\b/, /api\.gateio\.ws/];
    const offenders: string[] = [];
    for (const file of listFiles(CORE_SRC).filter((f) => f.endsWith(".ts"))) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file} cocok dengan ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("core tidak memanggil jam/random global di jalur akuntansi", () => {
    const offenders: string[] = [];
    for (const file of listFiles(CORE_SRC).filter((f) => f.endsWith(".ts"))) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      const isClockDefinition = file.endsWith("market.ts");
      if (!isClockDefinition && /Date\.now\(\)/.test(source)) {
        offenders.push(`${file} memakai Date.now()`);
      }
      if (/Math\.random\(\)/.test(source)) {
        offenders.push(`${file} memakai Math.random()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("package.json core hanya bergantung pada decimal.js dan zod", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["decimal.js", "zod"]);
  });
});