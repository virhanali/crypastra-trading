import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  canCancel,
  canTransition,
  InvalidOrderError,
  isImmediate,
  isOrderLive,
  isTerminalStatus,
  restsOnBook,
  statusAfterExecution,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
} from "../packages/core/src/index.js";

const ALL: OrderStatus[] = [
  "created",
  "validated",
  "rejected",
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "expired",
];

describe("3. state machine order", () => {
  test("transisi sah", () => {
    expect(canTransition("created", "validated")).toBe(true);
    expect(canTransition("created", "rejected")).toBe(true);
    expect(canTransition("validated", "open")).toBe(true);
    expect(canTransition("validated", "filled")).toBe(true);
    expect(canTransition("validated", "partially_filled")).toBe(true);
    expect(canTransition("validated", "cancelled")).toBe(true);
    expect(canTransition("open", "partially_filled")).toBe(true);
    expect(canTransition("open", "filled")).toBe(true);
    expect(canTransition("open", "cancelled")).toBe(true);
    expect(canTransition("partially_filled", "filled")).toBe(true);
    expect(canTransition("partially_filled", "cancelled")).toBe(true);
    expect(canTransition("partially_filled", "partially_filled")).toBe(true);
  });

  test("transisi ilegal ditolak", () => {
    expect(canTransition("filled", "open")).toBe(false);
    expect(canTransition("filled", "partially_filled")).toBe(false);
    expect(canTransition("cancelled", "filled")).toBe(false);
    expect(canTransition("rejected", "validated")).toBe(false);
    expect(canTransition("expired", "open")).toBe(false);
    expect(canTransition("created", "filled")).toBe(false);
    expect(canTransition("created", "open")).toBe(false);
  });

  test("assertTransition melempar untuk transisi ilegal", () => {
    expect(() => assertTransition("filled", "open")).toThrow(InvalidOrderError);
    expect(() => assertTransition("cancelled", "filled")).toThrow(InvalidOrderError);
    expect(() => assertTransition("created", "filled")).toThrow(InvalidOrderError);
  });

  test("assertTransition menolak transisi tanpa perubahan (kecuali partially_filled)", () => {
    expect(() => assertTransition("filled", "filled")).toThrow(InvalidOrderError);
    expect(() => assertTransition("created", "created")).toThrow(InvalidOrderError);
    // Fill tambahan pada order yang sudah partial itu sah.
    expect(() => assertTransition("partially_filled", "partially_filled")).not.toThrow();
  });

  test("status terminal tidak punya transisi keluar", () => {
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
      for (const target of ALL) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  test("status non-terminal dikenali", () => {
    expect(isTerminalStatus("created")).toBe(false);
    expect(isTerminalStatus("validated")).toBe(false);
    expect(isTerminalStatus("open")).toBe(false);
    expect(isTerminalStatus("partially_filled")).toBe(false);
  });

  test("hanya limit gtc/post_only yang resting", () => {
    expect(restsOnBook("limit", "gtc")).toBe(true);
    expect(restsOnBook("limit", "post_only")).toBe(true);
    expect(restsOnBook("limit", "ioc")).toBe(false);
    expect(restsOnBook("limit", "fok")).toBe(false);
    expect(restsOnBook("market", "gtc")).toBe(false);
    expect(restsOnBook("market", "ioc")).toBe(false);
  });

  test("market dan limit ioc/fok bersifat immediate", () => {
    expect(isImmediate("market", "ioc")).toBe(true);
    expect(isImmediate("limit", "ioc")).toBe(true);
    expect(isImmediate("limit", "fok")).toBe(true);
    expect(isImmediate("limit", "gtc")).toBe(false);
    expect(isImmediate("limit", "post_only")).toBe(false);
  });

  test("liveness: partially_filled hanya live untuk order resting", () => {
    expect(isOrderLive({ status: "open", type: "limit", timeInForce: "gtc" })).toBe(true);
    expect(isOrderLive({ status: "partially_filled", type: "limit", timeInForce: "gtc" })).toBe(true);
    // Immediate order yang partial sudah final (sisa dibatalkan).
    expect(isOrderLive({ status: "partially_filled", type: "market", timeInForce: "ioc" })).toBe(false);
    expect(isOrderLive({ status: "partially_filled", type: "limit", timeInForce: "ioc" })).toBe(false);
    expect(isOrderLive({ status: "filled", type: "limit", timeInForce: "gtc" })).toBe(false);
    expect(isOrderLive({ status: "cancelled", type: "limit", timeInForce: "gtc" })).toBe(false);
  });

  test("canCancel mengikuti liveness, bukan hanya status", () => {
    expect(canCancel({ status: "open", type: "limit", timeInForce: "gtc" })).toBe(true);
    expect(canCancel({ status: "partially_filled", type: "limit", timeInForce: "gtc" })).toBe(true);
    expect(canCancel({ status: "filled", type: "limit", timeInForce: "gtc" })).toBe(false);
    expect(canCancel({ status: "cancelled", type: "limit", timeInForce: "gtc" })).toBe(false);
    expect(canCancel({ status: "partially_filled", type: "market", timeInForce: "ioc" })).toBe(false);
  });

  test("status setelah eksekusi", () => {
    const immediate = { type: "market" as const, timeInForce: "ioc" as const };
    expect(statusAfterExecution({ ...immediate, filledSize: 5, requestedSize: 5 })).toBe("filled");
    expect(statusAfterExecution({ ...immediate, filledSize: 3, requestedSize: 5 })).toBe("partially_filled");
    expect(statusAfterExecution({ ...immediate, filledSize: 0, requestedSize: 5 })).toBe("cancelled");

    const resting = { type: "limit" as const, timeInForce: "gtc" as const };
    expect(statusAfterExecution({ ...resting, filledSize: 5, requestedSize: 5 })).toBe("filled");
    expect(statusAfterExecution({ ...resting, filledSize: 2, requestedSize: 5 })).toBe("partially_filled");
    // Resting tanpa fill TETAP open; order tidak boleh dibatalkan hanya karena
    // satu snapshot tidak menyentuhnya (bug yang ditemukan di Phase 3).
    expect(statusAfterExecution({ ...resting, filledSize: 0, requestedSize: 5 })).toBe("open");
    // post_only juga resting.
    expect(statusAfterExecution({ type: "limit", timeInForce: "post_only", filledSize: 0, requestedSize: 5 })).toBe("open");
    // Immediate tanpa fill memang berakhir cancelled.
    expect(statusAfterExecution({ type: "limit", timeInForce: "ioc", filledSize: 0, requestedSize: 5 })).toBe("cancelled");
  });
});
