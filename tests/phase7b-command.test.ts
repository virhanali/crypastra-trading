import { describe, expect, test } from "bun:test";
import { CommandBook, actionKey } from "../apps/web/src/lib/command-id.js";
import {
  abandon,
  beginSubmit,
  canRetry,
  initialTicketState,
  isBusy,
  statusText,
  submitDefinitivelyFailed,
  submitSucceeded,
  submitUncertain,
  type TicketState,
} from "../apps/web/src/lib/trade/ticket.js";
import type { OrderIntent } from "../apps/web/src/lib/trade/intent.js";

const INTENT: OrderIntent = {
  contract: "BTC_USDT",
  side: "buy",
  type: "market",
  size: 10,
  price: null,
  leverage: "10",
  timeInForce: "ioc",
  reduceOnly: false,
  tpPrice: null,
  slPrice: null,
};

/** Sidik jari aksi logis: seluruh field yang mengubah ekonomi. */
function orderFingerprint(accountId: string, intent: OrderIntent): string {
  return actionKey("submit_order", {
    accountId,
    contract: intent.contract,
    side: intent.side,
    type: intent.type,
    size: intent.size,
    leverage: intent.leverage,
    price: intent.price ?? "null",
    tp: intent.tpPrice ?? "null",
    sl: intent.slPrice ?? "null",
  });
}

describe("pengiriman tunggal", () => {
  test("satu aksi = satu commandId", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    let state = initialTicketState;
    const key = orderFingerprint("acc", INTENT);
    const commandId = book.for(key);

    state = beginSubmit(state, { commandId, actionKey: key, intent: INTENT });
    expect(state.state).toBe("submitting");
    expect(state.frozen!.commandId).toBe("cmd-1");
    expect(isBusy(state)).toBe(true);
    expect(statusText(state)).toBe("Mengirim order PAPER…");

    state = submitSucceeded();
    book.settle(key);
    expect(state.state).toBe("succeeded");
    expect(book.pending()).toBe(0);
  });
});

describe("double click tidak menghasilkan dua order", () => {
  test("klik kedua diabaikan selama pengiriman pertama berjalan", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = orderFingerprint("acc", INTENT);
    const commandId = book.for(key);

    let state = beginSubmit(initialTicketState, { commandId, actionKey: key, intent: INTENT });
    // Klik kedua: state sudah `submitting` → beginSubmit tidak menimpa payload.
    const again = beginSubmit(state, { commandId: "cmd-2", actionKey: key, intent: INTENT });
    expect(again).toBe(state);
    expect(again.frozen!.commandId).toBe("cmd-1");
    expect(book.for(key)).toBe("cmd-1");
    expect(book.pending()).toBe(1);
    state = submitSucceeded();
    void state;
  });
});

describe("timeout: hasil tidak pasti, bukan 'gagal'", () => {
  test("payload dibekukan dan retry memakai commandId + payload yang sama", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = orderFingerprint("acc", INTENT);
    const commandId = book.for(key);

    let state = beginSubmit(initialTicketState, { commandId, actionKey: key, intent: INTENT });
    state = submitUncertain(state, "timeout setelah kirim");

    expect(state.state).toBe("outcome_uncertain");
    // TIDAK boleh mengatakan gagal.
    expect(statusText(state)).toBe("Memeriksa status order…");
    expect(statusText(state)).not.toContain("gagal");
    // Payload tetap beku.
    expect(state.frozen!.commandId).toBe("cmd-1");
    expect(canRetry(state)).toBe(true);

    // Retry: commandId sama, payload sama.
    expect(book.for(key)).toBe("cmd-1");
    expect(state.frozen!.intent.size).toBe(10);
  });

  test("sunting field setelah hasil tidak pasti TIDAK mengubah perintah beku", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = orderFingerprint("acc", INTENT);
    const commandId = book.for(key);

    let state = beginSubmit(initialTicketState, { commandId, actionKey: key, intent: INTENT });
    state = submitUncertain(state, "putus");

    // Pengguna mengubah size di form menjadi 99…
    const edited = { ...INTENT, size: 99 };
    // …tetapi perintah yang tertunda tetap memakai payload beku.
    expect(state.frozen!.intent.size).toBe(10);
    expect(edited.size).toBe(99);
    // Aksi logis yang berbeda (size 99) memang memakai kunci berbeda…
    expect(orderFingerprint("acc", edited)).not.toBe(key);
    // …dan beginSubmit tetap menolak menimpa yang belum pasti.
    expect(beginSubmit(state, { commandId: "cmd-2", actionKey: key, intent: edited })).toBe(state);
  });

  test("abandon mengosongkan state supaya aksi baru boleh memakai commandId baru", () => {
    const state = submitUncertain(
      beginSubmit(initialTicketState, { commandId: "cmd-1", actionKey: "k", intent: INTENT }),
      "putus",
    );
    const cleared = abandon();
    expect(cleared.state).toBe("idle");
    expect(cleared.frozen).toBeNull();
    expect(isBusy(cleared)).toBe(false);
    void state;
  });
});

describe("kegagalan pasti boleh mengubah payload", () => {
  test("penolakan backend mengosongkan payload beku", () => {
    const state: TicketState = submitDefinitivelyFailed("INSUFFICIENT_BALANCE", "Saldo virtual tidak cukup");
    expect(state.state).toBe("definitively_failed");
    expect(state.frozen).toBeNull();
    expect(canRetry(state)).toBe(false);
    expect(statusText(state)).toContain("Order ditolak");
    expect(statusText(state)).toContain("Saldo virtual tidak cukup");
  });

  test("kode error backend tetap dapat diakses untuk debugging", () => {
    const state = submitDefinitivelyFailed("INVALID_ORDER", "TP LONG harus di atas entry");
    expect(state.errorCode).toBe("INVALID_ORDER");
    // Tidak ada stack trace di pesan yang ditampilkan.
    expect(statusText(state)).not.toContain("    at ");
  });
});

describe("replay: satu perintah menghasilkan tepat satu order", () => {
  test("Kirim → timeout → retry (idempoten) → satu efek ekonomi", async () => {
    // Simulasi backend idempoten: efek hanya diterapkan sekali per commandId.
    const effects: string[] = [];
    const committed = new Set<string>();
    const backend = async (commandId: string): Promise<"ok" | "timeout"> => {
      if (!committed.has(commandId)) {
        // Commit terjadi, tetapi respons hilang.
        committed.add(commandId);
        effects.push(commandId);
        return "timeout";
      }
      // Retry dengan commandId sama: backend mengenali sebagai retry.
      return "ok";
    };

    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = orderFingerprint("acc", INTENT);
    let state: TicketState = initialTicketState;

    // 1) Kirim pertama → timeout (padahal commit).
    const first = book.for(key);
    state = beginSubmit(state, { commandId: first, actionKey: key, intent: INTENT });
    if ((await backend(first)) === "timeout") {
      state = submitUncertain(state, "timeout setelah kirim");
    }
    expect(state.state).toBe("outcome_uncertain");

    // 2) Retry memakai commandId SAMA.
    const retryId = book.for(key);
    expect(retryId).toBe(first);
    const outcome = await backend(retryId);
    expect(outcome).toBe("ok");
    state = submitSucceeded();
    book.settle(key);

    // Tepat satu efek ekonomi.
    expect(effects).toEqual([first]);
    expect(state.state).toBe("succeeded");
  });
});
