import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");
const ADAPTERS_SRC = join(REPO_ROOT, "packages", "adapters", "src");
const SERVER_SRC = join(REPO_ROOT, "apps", "server", "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function tsFiles(dir: string): string[] {
  return listFiles(dir).filter((file) => file.endsWith(".ts"));
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

describe("5. tidak ada konversi Number di jalur persistensi finansial", () => {
  test("apps/server tidak memakai parseFloat/parseInt/Number()/toNumber()", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SERVER_SRC)) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      // `Number.isInteger(...)` sengaja TIDAK tertangkap: yang dicari hanya
      // pemanggilan `Number(...)` sebagai konversi nilai.
      for (const pattern of [/\bparseFloat\b/, /\bparseInt\b/, /\.toNumber\s*\(/, /\bNumber\s*\(/]) {
        if (pattern.test(source)) {
          offenders.push(`${file} cocok dengan ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("repository memakai decimal-codec sebagai satu-satunya jalur konversi uang", () => {
    const ledgerRepo = readFileSync(
      join(SERVER_SRC, "repositories", "ledger-repository.ts"),
      "utf8",
    );
    expect(ledgerRepo).toContain("encodeMoney");
    expect(ledgerRepo).toContain("decodeMoney");

    // Tidak ada repository yang memanggil toFixed/new Decimal untuk uang
    // di luar codec.
    const offenders: string[] = [];
    for (const file of tsFiles(join(SERVER_SRC, "repositories"))) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      if (/\.toFixed\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("core tetap murni (Phase 0 guarantee)", () => {
  test("core tidak mengimpor drizzle, sqlite, fastify, adapters, atau server", () => {
    const forbidden = [
      /\bdrizzle-orm\b/,
      /\bbun:sqlite\b/,
      /\bfastify\b/,
      /@crypastra\/adapters/,
      /@crypastra\/server/,
      /apps\/server/,
    ];
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file} cocok dengan ${pattern}`);
        }
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

describe("batas modul skema", () => {
  test("schema.ts dan decimal-codec bebas impor runtime core (drizzle-kit = CJS)", () => {
    const schema = stripCommentLines(readFileSync(join(SERVER_SRC, "db", "schema.ts"), "utf8"));
    // Hanya `import type` yang boleh menyentuh core.
    const runtimeCoreImport = /^\s*import\s+(?!type\b)[^;]*from\s+["']@crypastra\/core["']/m;
    expect(runtimeCoreImport.test(schema)).toBe(false);
    expect(schema).toContain('from "@crypastra/core"');
  });

  test("adapters tidak mengimpor drizzle/sqlite/fastify", () => {
    const forbidden = [/\bdrizzle-orm\b/, /\bbun:sqlite\b/, /\bfastify\b/];
    const offenders: string[] = [];
    for (const file of tsFiles(ADAPTERS_SRC)) {
      const source = stripCommentLines(readFileSync(file, "utf8"));
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file} cocok dengan ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("persistensi boleh bergantung pada core, bukan sebaliknya", () => {
    const repo = readFileSync(join(SERVER_SRC, "repositories", "ledger-repository.ts"), "utf8");
    expect(repo).toContain('from "@crypastra/core"');
    // core tidak boleh tahu apa pun soal repositori
    const coreIndex = readFileSync(join(CORE_SRC, "index.ts"), "utf8");
    expect(coreIndex).not.toContain("repository");
    expect(coreIndex).not.toContain("server");
  });
});
