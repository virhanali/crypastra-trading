import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SCANNER_CONFIG,
  ScannerConfigSchema,
  applyClosedCandle,
  createEngineState,
  scan,
  scannerConfigHash,
  type Candle,
  type FeatureSnapshot,
  type ScannerConfig,
} from "@crypastra/core";
import { AnalyticsService } from "../apps/server/src/analytics/analytics-service.js";
import type { DatabaseConnection } from "../apps/server/src/db/database.js";
import { bearishSetupCandles, bullishSetupCandles, syntheticCandles } from "./helpers/candles.js";
import { openTempDatabase } from "./helpers/db.js";

const CONTRACT = "ETH_USDT";

function lastSnapshot(candles: readonly Candle[], contract = CONTRACT): FeatureSnapshot {
  const state = createEngineState(contract);
  let last: FeatureSnapshot | null = null;
  for (const candle of candles) {
    const outcome = applyClosedCandle(state, candle);
    if (outcome.status === "applied") last = outcome.snapshot;
  }
  if (last === null) throw new Error("tidak ada snapshot");
  return last;
}

/** Buang komentar supaya guard menilai KODE, bukan prosa dokumentasi. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function fixedClock(startMs = 1_800_000_000_000) {
  let now = startMs;
  return {
    nowMs: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function countRows(connection: DatabaseConnection, table: string): number {
  const row = connection.sqlite
    .query(`SELECT count(*) AS n FROM ${table}`)
    .get() as { n: number } | null;
  return row?.n ?? 0;
}

describe("Phase 9 — hard scanner", () => {
  test("uptrend + momentum + volume menghasilkan kandidat LONG", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const result = scan(features, DEFAULT_SCANNER_CONFIG, scannerConfigHash(DEFAULT_SCANNER_CONFIG));
    expect(result.status).toBe("candidate");
    expect(result.direction).toBe("long");
    expect(result.signal).toBe("long");
    expect(result.setupType).toBe("trend_continuation_long");
    expect(result.reasonCodes).toContain("TREND_BULLISH");
    expect(result.reasonCodes).toContain("MOMENTUM_LONG");
  });

  test("downtrend menghasilkan kandidat SHORT", () => {
    const features = lastSnapshot(bearishSetupCandles(CONTRACT));
    const result = scan(features, DEFAULT_SCANNER_CONFIG, "");
    expect(result.signal).toBe("short");
    expect(result.direction).toBe("short");
    expect(result.reasonCodes).toContain("TREND_BEARISH");
  });

  test("warmup belum selesai → skip dengan WARMUP_INCOMPLETE", () => {
    const features = lastSnapshot(syntheticCandles(CONTRACT, 100));
    const result = scan(features, DEFAULT_SCANNER_CONFIG, "");
    expect(result.status).toBe("skip");
    expect(result.signal).toBe("neutral");
    expect(result.reasonCodes).toEqual(["WARMUP_INCOMPLETE"]);
  });

  test("minimumHistory menaikkan syarat → INSUFFICIENT_HISTORY", () => {
    const features = lastSnapshot(syntheticCandles(CONTRACT, 210));
    const config: ScannerConfig = { ...DEFAULT_SCANNER_CONFIG, minimumHistory: 500 };
    const result = scan(features, config, "");
    expect(result.status).toBe("skip");
    expect(result.reasonCodes).toEqual(["INSUFFICIENT_HISTORY"]);
  });

  test("volatilitas terlalu rendah → VOLATILITY_TOO_LOW dan bukan kandidat", () => {
    const features = lastSnapshot(
      Array.from({ length: 260 }, (_, index) => {
        const price = "100";
        return {
          contract: CONTRACT,
          interval: "5m",
          openTimeSeconds: 1_700_000_000 + index * 300,
          o: price,
          h: price,
          l: price,
          c: price,
          v: 100,
          sum: "10000",
          windowClosed: true,
        } satisfies Candle;
      }),
    );
    const result = scan(features, DEFAULT_SCANNER_CONFIG, "");
    expect(result.reasonCodes).toContain("VOLATILITY_TOO_LOW");
    expect(result.status).toBe("skip");
  });

  test("harga terlalu jauh dari EMA20 → OVEREXTENDED", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const config: ScannerConfig = { ...DEFAULT_SCANNER_CONFIG, maxDistanceFromEma20: "0.01" };
    const result = scan(features, config, "");
    expect(result.reasonCodes).toContain("OVEREXTENDED");
    expect(result.status).toBe("skip");
  });

  test("setiap hasil scanner dapat dijelaskan dari reasonCodes", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const result = scan(features, DEFAULT_SCANNER_CONFIG, "");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain(
      result.facts.trendAligned ? "TREND_BULLISH" : "TREND_NOT_ALIGNED",
    );
    expect(result.facts.volumeConfirmed).toBe(result.reasonCodes.includes("VOLUME_CONFIRMED"));
  });

  test("hasil scanner tidak memuat ukuran posisi/leverage", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const result = scan(features, DEFAULT_SCANNER_CONFIG, "");
    const keys = Object.keys(result).join(",");
    expect(keys).not.toMatch(/size|leverage|notional|margin|quantity|balance/i);
  });
});

describe("Phase 9 — konfigurasi scanner", () => {
  test("config hash stabil dan berubah ketika config berubah", () => {
    const a = scannerConfigHash(DEFAULT_SCANNER_CONFIG);
    const b = scannerConfigHash({ ...DEFAULT_SCANNER_CONFIG });
    const c = scannerConfigHash({ ...DEFAULT_SCANNER_CONFIG, minVolumeRatio: "1.5" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("config hash tidak bergantung urutan literal kunci", () => {
    const reordered = Object.fromEntries(
      Object.entries(DEFAULT_SCANNER_CONFIG).reverse(),
    ) as unknown as ScannerConfig;
    expect(scannerConfigHash(reordered)).toBe(scannerConfigHash(DEFAULT_SCANNER_CONFIG));
  });

  test("default V1 konservatif dan terdokumentasi", () => {
    const config = ScannerConfigSchema.parse({});
    expect(config.minVolumeRatio).toBe("1.0");
    expect(config.minAtrPercent).toBe("0.2");
    expect(config.maxAtrPercent).toBe("5.0");
    expect(config.maxDistanceFromEma20).toBe("3.0");
    expect(config.requireTrendAlignment).toBe(true);
    expect(config.useBtcContext).toBe(false);
    expect(config.minimumHistory).toBe(200);
  });
});

describe("Phase 9 — konteks BTC", () => {
  test("BTC tidak memengaruhi fitur kontrak lain", () => {
    const eth = lastSnapshot(syntheticCandles(CONTRACT, 280), CONTRACT);
    const btc = lastSnapshot(syntheticCandles("BTC_USDT", 280), "BTC_USDT");
    const ethAgain = lastSnapshot(syntheticCandles(CONTRACT, 280), CONTRACT);
    expect(ethAgain).toEqual(eth);
    expect(btc.contract).toBe("BTC_USDT");
  });

  test("konteks BTC tidak dipakai kecuali config memintanya", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const conflict = {
      contract: "BTC_USDT",
      trendStructure: "bearish",
      return1: "-0.01",
      return12: "-0.05",
      atrPercent: "1.5",
      close: "50000",
    };
    const ignored = scan(features, DEFAULT_SCANNER_CONFIG, "", conflict);
    expect(ignored.reasonCodes).not.toContain("BTC_CONTEXT_CONFLICT");

    const required = scan(
      features,
      { ...DEFAULT_SCANNER_CONFIG, useBtcContext: true, requireBtcAlignment: true },
      "",
      conflict,
    );
    expect(required.reasonCodes).toContain("BTC_CONTEXT_CONFLICT");
    expect(required.signal).toBe("neutral");
  });

  test("konteks BTC yang selaras tidak memveto sinyal", () => {
    const features = lastSnapshot(bullishSetupCandles(CONTRACT));
    const aligned = {
      contract: "BTC_USDT",
      trendStructure: "bullish",
      return1: "0.01",
      return12: "0.05",
      atrPercent: "1.5",
      close: "50000",
    };
    const result = scan(
      features,
      { ...DEFAULT_SCANNER_CONFIG, useBtcContext: true, requireBtcAlignment: true },
      "",
      aligned,
    );
    expect(result.reasonCodes).toContain("BTC_CONTEXT_ALIGNED");
    expect(result.signal).toBe("long");
  });
});

describe("Phase 9 — isolasi arsitektur", () => {
  test("inti analytics murni: tanpa DB, order, ledger, waktu, atau acak", () => {
    const dir = "packages/core/src/analytics";
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      "Date.now(",
      "Math.random(",
      "node:crypto",
      "drizzle",
      "order-service",
      "position-service",
      "ledger",
      "repositories",
      "balance",
      "leverage",
      "wallet",
      "fastify",
      "WebSocket",
      "@crypastra/adapters",
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(join(dir, file), "utf8"));
      for (const token of forbidden) {
        expect(source.includes(token)).toBe(false);
      }
      // Impor hanya boleh dari dalam inti atau dependensi murni inti.
      const pureDeps = new Set(["zod", "decimal.js"]);
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        expect(specifier.startsWith(".") || pureDeps.has(specifier)).toBe(true);
      }
    }
  });

  test("service analytics tidak mengimpor layanan ekonomi", () => {
    const source = stripComments(
      readFileSync("apps/server/src/analytics/analytics-service.ts", "utf8"),
    );
    for (const token of [
      "order-service",
      "position-service",
      "account-service",
      "mark-to-market-service",
      "ledger-repository",
      "OrderService",
      "PositionService",
      "LedgerRepository",
      "realtime",
    ]) {
      expect(source.includes(token)).toBe(false);
    }
  });
});

describe("Phase 9 — AnalyticsService (livestream bersama live/replay)", () => {
  test("memproses candle tertutup, menaikkan counter, dan tidak menyentuh ekonomi", () => {
    const db = openTempDatabase();
    try {
      const clock = fixedClock();
      const counters = [];
      const analytics = new AnalyticsService({
        connection: db.connection,
        clock,
        onDiagnostic: (event) => counters.push(event.type),
      });
      const economic = ["ledger", "orders", "positions", "fills", "domain_events", "account_balances"];
      const before = economic.map((table) => countRows(db.connection, table));

      for (const candle of syntheticCandles(CONTRACT, 280)) {
        clock.advance(300_000);
        analytics.onClosedCandle(candle);
      }

      const after = economic.map((table) => countRows(db.connection, table));
      expect(after).toEqual(before);

      const stats = analytics.counters();
      expect(stats.candlesProcessed).toBe(280);
      expect(stats.featureSnapshotsProduced).toBe(280);
      expect(stats.featureSnapshotsPersisted).toBe(280);
      expect(stats.longSignals + stats.shortSignals + stats.neutralSignals).toBe(81);
      expect(analytics.persistedFeatureCount()).toBe(280);
      expect(analytics.persistedScannerCount()).toBe(81);
      expect(analytics.digest().snapshotCount).toBe(280);
    } finally {
      db.cleanup();
    }
  });

  test("candle duplikat dan out-of-order tidak menggandakan snapshot", () => {
    const db = openTempDatabase();
    try {
      const analytics = new AnalyticsService({ connection: db.connection, clock: fixedClock() });
      const candles = syntheticCandles(CONTRACT, 210);
      for (const candle of candles) analytics.onClosedCandle(candle);
      analytics.onClosedCandle(candles.at(-1)!);
      analytics.onClosedCandle(candles[3]!);
      const stats = analytics.counters();
      expect(stats.duplicateCandles).toBe(1);
      expect(stats.outOfOrderCandles).toBe(1);
      expect(analytics.persistedFeatureCount()).toBe(210);
    } finally {
      db.cleanup();
    }
  });

  test("interval lain diabaikan tanpa mengotori keadaan", () => {
    const db = openTempDatabase();
    try {
      const analytics = new AnalyticsService({ connection: db.connection, clock: fixedClock() });
      analytics.onClosedCandle({ ...syntheticCandles(CONTRACT, 1)[0]!, interval: "1m" });
      expect(analytics.counters().otherIntervalCandles).toBe(1);
      expect(analytics.counters().candlesProcessed).toBe(0);
      expect(analytics.persistedFeatureCount()).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  test("kegagalan persistensi tidak menjatuhkan ingest", () => {
    const db = openTempDatabase();
    try {
      const analytics = new AnalyticsService({ connection: db.connection, clock: fixedClock() });
      db.connection.close();
      expect(() => {
        analytics.onClosedCandle(syntheticCandles(CONTRACT, 1)[0]!);
      }).not.toThrow();
      expect(analytics.counters().errors).toBeGreaterThan(0);
    } finally {
      db.cleanup();
    }
  });

  test("snapshot idempoten per (contract, interval, t, featureVersion)", () => {
    const db = openTempDatabase();
    try {
      const candles = syntheticCandles(CONTRACT, 210);
      const first = new AnalyticsService({ connection: db.connection, clock: fixedClock() });
      for (const candle of candles) first.onClosedCandle(candle);
      const second = new AnalyticsService({ connection: db.connection, clock: fixedClock() });
      for (const candle of candles) second.onClosedCandle(candle);
      expect(second.persistedFeatureCount()).toBe(210);
      expect(second.counters().featureSnapshotsPersisted).toBe(0);
      expect(first.counters().featureSnapshotsPersisted).toBe(210);
    } finally {
      db.cleanup();
    }
  });
});

describe("Phase 9 — determinisme riset", () => {
  function runOnce(connection: DatabaseConnection) {
    const analytics = new AnalyticsService({
      connection,
      clock: fixedClock(),
      persist: false,
    });
    for (const candle of syntheticCandles(CONTRACT, 280)) analytics.onClosedCandle(candle);
    return analytics.digest();
  }

  test("dua run atas rangkaian candle yang sama menghasilkan hash identik", () => {
    const db = openTempDatabase();
    try {
      const a = runOnce(db.connection);
      const b = runOnce(db.connection);
      expect(a.combinedHash).toBe(b.combinedHash);
      expect(a.combinedHash).toMatch(/^[0-9a-f]{16}$/);
      expect(a.reasonCodeCounts).toEqual(b.reasonCodeCounts);
    } finally {
      db.cleanup();
    }
  });

  test("hash riset berubah bila rangkaian candle berubah", () => {
    const db = openTempDatabase();
    try {
      const a = runOnce(db.connection);
      const analytics = new AnalyticsService({
        connection: db.connection,
        clock: fixedClock(),
        persist: false,
      });
      for (const candle of syntheticCandles(CONTRACT, 279)) analytics.onClosedCandle(candle);
      expect(analytics.digest().combinedHash).not.toBe(a.combinedHash);
    } finally {
      db.cleanup();
    }
  });

  test("golden fixture: hash riset beku untuk 280 candle sintetis", () => {
    const db = openTempDatabase();
    try {
      const digest = runOnce(db.connection);
      // Hash beku — regresi apa pun pada definisi indikator akan mengubahnya.
      expect(digest.combinedHash).toBe("d9f221276d8fc312");
      expect(digest.snapshotCount).toBe(280);
      expect(digest.resultCount).toBe(81);
    } finally {
      db.cleanup();
    }
  });
});
