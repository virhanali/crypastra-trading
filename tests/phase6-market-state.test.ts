import { describe, expect, test } from "bun:test";
import { Decimal, DepthBook, MarketStateStore, type DepthUpdate } from "../packages/core/src/index.js";

const bid = (price: string, size: number) => ({ price, size });
const ask = (price: string, size: number) => ({ price, size });

const update = (firstUpdateId: number, lastUpdateId: number, bids: any[], asks: any[]): DepthUpdate => ({
  contract: "BTC_USDT",
  firstUpdateId,
  lastUpdateId,
  bids,
  asks,
});

describe("9 & 11. buku kedalaman lokal", () => {
  test("bootstrap: update ditampung sampai snapshot tiba, lalu SYNCED", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    expect(book.status).toBe("syncing");
    // Update datang sebelum snapshot → ditampung.
    book.applyUpdate(update(102, 104, [bid("80000", 5)], []), 1);
    expect(book.status).toBe("syncing");
    // Snapshot dengan id 100; update 102..104 TIDAK menyambung (butuh 101).
    book.applySnapshot({ contract: "BTC_USDT", updateId: 100, bids: [bid("79999", 1)], asks: [ask("80001", 1)] }, 1);
    expect(book.status).toBe("syncing");

    // Update 101 menyambung → SYNCED dan buffered 102..104 diterapkan.
    book.applyUpdate(update(101, 101, [bid("80000", 5)], []), 1);
    expect(book.status).toBe("synced");
    // Buffered 102..104 ikut diterapkan.
    expect(book.state().updateId).toBe(104);
  });

  test("snapshot lalu update yang menyambung → SYNCED", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    const status = book.applySnapshot(
      { contract: "BTC_USDT", updateId: 100, bids: [bid("79999", 1)], asks: [ask("80001", 1)] },
      1,
    );
    expect(status).toBe("syncing");
    book.applyUpdate(update(101, 101, [bid("80000", 2)], [ask("80002", 3)]), 1);
    expect(book.status).toBe("synced");
    expect(book.state().updateId).toBe(101);
  });

  test("ukuran ABSOLUT menggantikan, bukan menambah", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot(
      {
        contract: "BTC_USDT",
        updateId: 1,
        bids: [bid("79999", 10), bid("79998", 7)],
        asks: [ask("80001", 4)],
      },
      1,
    );
    book.applyUpdate(update(2, 2, [bid("79999", 3)], []), 1);
    expect(book.status).toBe("synced");
    const snapshot = book.toBookSnapshot(10, 2)!;
    // 3, bukan 13.
    expect(snapshot.bids[0]).toEqual({ price: "79999", size: 3 });
  });

  test("size == 0 menghapus level", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot(
      {
        contract: "BTC_USDT",
        updateId: 1,
        bids: [bid("79999", 10), bid("79998", 7)],
        asks: [ask("80001", 4), ask("80002", 9)],
      },
      1,
    );
    book.applyUpdate(update(2, 2, [bid("79999", 0)], [ask("80001", 0)]), 1);
    const snapshot = book.toBookSnapshot(10, 2)!;
    expect(snapshot.bids.map((level) => level.price)).toEqual(["79998"]);
    expect(snapshot.asks.map((level) => level.price)).toEqual(["80002"]);
  });

  test("urutan: bid menurun, ask menaik; perbandingan desimal (bukan float)", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    // Snapshot harus SUDAH terurut (Gate mengirimnya terurut); validasi menolak
    // yang tidak terurut.
    book.applySnapshot(
      {
        contract: "BTC_USDT",
        updateId: 1,
        bids: [bid("80000", 1)],
        asks: [ask("80001.05", 1)],
      },
      1,
    );
    // Level tambahan masuk lewat update dalam urutan acak.
    book.applyUpdate(
      update(2, 2, [bid("79999.10", 1), bid("79999.9", 1)], [ask("80001.9", 1), ask("80001.10", 1)]),
      1,
    );
    expect(book.status).toBe("synced");
    const snapshot = book.toBookSnapshot(10, 2)!;
    // Perbandingan desimal: 79999.9 > 79999.1 (bukan perbandingan string "10" < "9").
    // Harga dinormalkan Decimal: "79999.10" disimpan sebagai "79999.1".
    expect(snapshot.bids.map((level) => level.price)).toEqual(["80000", "79999.9", "79999.1"]);
    expect(snapshot.asks.map((level) => level.price)).toEqual(["80001.05", "80001.1", "80001.9"]);
  });

  test("gap update id → UNSYNCED dan buku tidak dapat dieksekusi", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 1, bids: [bid("79999", 1)], asks: [ask("80001", 1)] }, 1);
    book.applyUpdate(update(2, 2, [bid("79998", 1)], []), 1);
    expect(book.status).toBe("synced");

    // Lompat dari 2 ke 9: ada lubang.
    book.applyUpdate(update(9, 10, [bid("79997", 1)], []), 50);
    expect(book.status).toBe("unsynced");
    expect(book.isExecutable()).toBe(false);
    expect(book.toBookSnapshot(10, 50)).toBeNull();
    expect(book.state().lastGapAt).toBe(50);
  });

  test("setelah UNSYNCED, update baru diabaikan sampai resync eksplisit", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 1, bids: [bid("79999", 1)], asks: [ask("80001", 1)] }, 1);
    // Update yang menyambung → SYNCED.
    book.applyUpdate(update(2, 2, [bid("79998", 1)], []), 1);
    expect(book.status).toBe("synced");

    // Lompat 2 → 9: gap.
    book.applyUpdate(update(9, 9, [], []), 1);
    expect(book.status).toBe("unsynced");

    // Update berikutnya diabaikan selama UNSYNCED.
    book.applyUpdate(update(10, 10, [bid("79990", 5)], []), 1);
    expect(book.status).toBe("unsynced");

    // Resync dari snapshot.
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 20, bids: [bid("79995", 2)], asks: [ask("80005", 2)] }, 2);
    book.applyUpdate(update(21, 21, [bid("79996", 3)], []), 2);
    expect(book.status).toBe("synced");
    expect(book.toBookSnapshot(10, 2)!.bids[0]).toEqual({ price: "79996", size: 3 });
  });

  test("markUnsynced membersihkan buku dan menaikkan hitungan resync tidak", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 1, bids: [bid("79999", 1)], asks: [ask("80001", 1)] }, 1);
    book.applyUpdate(update(2, 2, [], []), 1);
    expect(book.status).toBe("synced");
    book.markUnsynced(99);
    expect(book.status).toBe("unsynced");
    expect(book.state().bidCount).toBe(0);
    expect(book.state().lastGapAt).toBe(99);
  });

  test("update basi (lastUpdateId sudah tercakup) tidak merusak kontinuitas", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 5, bids: [bid("79999", 1)], asks: [ask("80001", 1)] }, 1);
    book.applyUpdate(update(6, 6, [bid("79998", 2)], []), 1);
    // Update lama 3..4 yang datang terlambat tidak boleh membuat UNSYNCED.
    book.applyUpdate(update(3, 4, [bid("79997", 9)], []), 1);
    expect(book.status).toBe("synced");
  });

  test("best bid/ask dan sisi kosong", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    book.applySnapshot({ contract: "BTC_USDT", updateId: 1, bids: [], asks: [] }, 1);
    expect(book.bestBid()).toBeNull();
    expect(book.bestAsk()).toBeNull();
    expect(book.toBookSnapshot(10, 1)).toBeNull(); // belum synced
  });

  test("snapshot tidak terurut ditolak", () => {
    const book = new DepthBook("BTC_USDT");
    book.beginSync();
    expect(() =>
      book.applySnapshot(
        { contract: "BTC_USDT", updateId: 1, bids: [bid("79998", 1), bid("79999", 1)], asks: [] },
        1,
      ),
    ).toThrow();
  });

  test("kontrak tidak cocok ditolak", () => {
    const book = new DepthBook("BTC_USDT");
    expect(() =>
      book.applySnapshot({ contract: "ETH_USDT", updateId: 1, bids: [], asks: [] }, 1),
    ).toThrow();
  });
});

describe("5. MarketState", () => {
  test("mark, last, dan index disimpan terpisah dan tidak saling menggantikan", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    store.applyTicker({
      contract: "BTC_USDT",
      lastPrice: "80000",
      markPrice: "80045.5",
      indexPrice: "80090.1",
      fundingRate: "0.0001",
      fundingNextApplySeconds: 1789920000,
      fundingIntervalSeconds: 28800,
      sourceTimestampMs: 1000,
      receivedAtMs: 1100,
    });
    const state = store.get("BTC_USDT")!;
    expect(state.lastPrice!.toString()).toBe("80000");
    expect(state.markPrice!.toString()).toBe("80045.5");
    expect(state.indexPrice!.toString()).toBe("80090.1");
    // Waktu exchange dan waktu penerimaan dibedakan.
    expect(state.markPriceAtMs).toBe(1000);
    expect(state.lastReceivedAtMs).toBe(1100);
  });

  test("field yang tidak ada tetap null (tidak dikarang)", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    store.applyTicker({
      contract: "BTC_USDT",
      lastPrice: "80000",
      markPrice: null,
      indexPrice: null,
      fundingRate: null,
      fundingNextApplySeconds: null,
      fundingIntervalSeconds: null,
      sourceTimestampMs: 1,
      receivedAtMs: 1,
    });
    const state = store.get("BTC_USDT")!;
    expect(state.lastPrice!.toString()).toBe("80000");
    expect(state.markPrice).toBeNull();
    expect(state.indexPrice).toBeNull();
    expect(state.fundingRate).toBeNull();
  });

  test("book ticker kosong tidak menghasilkan kutipan palsu", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    store.applyBookTicker({
      contract: "BTC_USDT",
      bestBid: "79999",
      bestBidSize: 10,
      bestAsk: null,
      bestAskSize: null,
      updateId: 5,
      sourceTimestampMs: 1,
      receivedAtMs: 1,
    });
    // Hanya satu sisi → tidak ada kutipan.
    expect(store.topOfBook("BTC_USDT")).toBeNull();

    store.applyBookTicker({
      contract: "BTC_USDT",
      bestBid: "79999",
      bestBidSize: 10,
      bestAsk: "80001",
      bestAskSize: 4,
      updateId: 6,
      sourceTimestampMs: 2,
      receivedAtMs: 2,
    });
    const top = store.topOfBook("BTC_USDT")!;
    expect(top.bid.price).toBe("79999");
    expect(top.ask.price).toBe("80001");
  });

  test("candle: terbaru dan terakhir tertutup dipisahkan", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    const candle = (t: number, windowClosed: boolean) => ({
      contract: "BTC_USDT",
      interval: "5m",
      openTimeSeconds: t,
      o: "1",
      h: "2",
      l: "0.5",
      c: "1.5",
      v: 10,
      sum: "15",
      windowClosed,
    });
    store.applyCandle({ candle: candle(100, false), receivedAtMs: 1 });
    expect(store.get("BTC_USDT")!.latestCandle!.openTimeSeconds).toBe(100);
    expect(store.get("BTC_USDT")!.latestClosedCandle).toBeNull();

    // Candle berikutnya → candle lama menjadi "terakhir tertutup".
    store.applyCandle({ candle: candle(400, false), receivedAtMs: 2 });
    expect(store.get("BTC_USDT")!.latestCandle!.openTimeSeconds).toBe(400);
    expect(store.get("BTC_USDT")!.latestClosedCandle!.openTimeSeconds).toBe(100);
  });

  test("snapshot() membedakan waktu exchange dan waktu terima", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    store.applyTicker({
      contract: "BTC_USDT",
      lastPrice: "1",
      markPrice: "2",
      indexPrice: "3",
      fundingRate: null,
      fundingNextApplySeconds: null,
      fundingIntervalSeconds: null,
      sourceTimestampMs: 100,
      receivedAtMs: 250,
    });
    const snapshot = store.snapshot("BTC_USDT")!;
    expect(snapshot.markSourceTimestampMs).toBe(100);
    expect(snapshot.markReceivedAtMs).toBe(250);
    expect(snapshot.markPrice!.eq(new Decimal(2))).toBe(true);
  });

  test("kontrak tidak dilacak ditolak", () => {
    const store = new MarketStateStore(["BTC_USDT"]);
    expect(() =>
      store.applyTicker({
        contract: "NOPE_USDT",
        lastPrice: "1",
        markPrice: null,
        indexPrice: null,
        fundingRate: null,
        fundingNextApplySeconds: null,
        fundingIntervalSeconds: null,
        sourceTimestampMs: 1,
        receivedAtMs: 1,
      }),
    ).toThrow();
  });
});
