import { describe, expect, test } from "bun:test";
import { CommandBook, actionKey } from "../apps/web/src/lib/command-id.js";
import { filterContracts, pathForContract, routeFromPath } from "../apps/web/src/lib/terminal-state.js";
import { DomainStream, type WebSocketLike } from "../apps/web/src/lib/realtime/domain-stream.js";
import { MarketStream } from "../apps/web/src/lib/realtime/market-stream.js";
import {
  applyMarketEvent,
  deriveFeedStatus,
  emptyMarketState,
  mergeServerState,
} from "../apps/web/src/lib/stores/terminal.svelte.js";
import type { MarketStateDto } from "../apps/web/src/lib/api/types.js";

describe("commandId: dipakai ulang untuk retry aksi yang sama", () => {
  test("aksi yang sama menghasilkan commandId yang sama", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = actionKey("deposit", { accountId: "a", amount: "100" });
    expect(book.for(key)).toBe("cmd-1");
    // Retry (mis. timeout) memakai id yang SAMA.
    expect(book.for(key)).toBe("cmd-1");
    expect(book.for(key)).toBe("cmd-1");
    expect(book.pending()).toBe(1);
  });

  test("aksi berbeda menghasilkan commandId berbeda", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const a = book.for(actionKey("deposit", { accountId: "a", amount: "100" }));
    const b = book.for(actionKey("deposit", { accountId: "a", amount: "200" }));
    expect(a).not.toBe(b);
    expect(book.pending()).toBe(2);
  });

  test("setelah sukses definitif, aksi berikutnya memakai id baru", () => {
    let counter = 0;
    const book = new CommandBook(() => `cmd-${(counter += 1)}`);
    const key = actionKey("deposit", { accountId: "a", amount: "100" });
    expect(book.for(key)).toBe("cmd-1");
    book.settle(key);
    expect(book.for(key)).toBe("cmd-2");
  });

  test("urutan kunci parameter tidak memengaruhi id", () => {
    expect(actionKey("deposit", { a: "1", b: "2" })).toBe(actionKey("deposit", { b: "2", a: "1" }));
  });
});

describe("state URL", () => {
  test("kontrak terbaca dari path dan bertahan setelah refresh", () => {
    expect(routeFromPath("/trade/BTC_USDT").contract).toBe("BTC_USDT");
    expect(routeFromPath("/trade/ETH_USDT/").contract).toBe("ETH_USDT");
    expect(pathForContract("BTC_USDT")).toBe("/trade/BTC_USDT");
  });

  test("path tidak dikenal memakai fallback", () => {
    expect(routeFromPath("/").contract).toBe("BTC_USDT");
    expect(routeFromPath("/apa-saja").contract).toBe("BTC_USDT");
    expect(routeFromPath("/", "SOL_USDT").contract).toBe("SOL_USDT");
  });

  test("URL tidak memuat state akuntansi", () => {
    expect(pathForContract("BTC_USDT")).not.toContain("balance");
    expect(pathForContract("BTC_USDT")).not.toContain("account");
  });

  test("filter watchlist", () => {
    const contracts = [{ contract: "BTC_USDT" }, { contract: "ETH_USDT" }, { contract: "SOL_USDT" }];
    expect(filterContracts(contracts, "btc")).toHaveLength(1);
    expect(filterContracts(contracts, "usdt")).toHaveLength(3);
    expect(filterContracts(contracts, "zzz")).toHaveLength(0);
    expect(filterContracts(contracts, "")).toHaveLength(3);
  });
});

/** WebSocket palsu deterministik. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.({});
  }
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe("stream domain: dedupe seq, resume, resync_required", () => {
  function setup(afterSeq = 0) {
    const socket = new FakeSocket();
    const events: Array<{ seq: number; type: string }> = [];
    const resyncs: string[] = [];
    const states: string[] = [];
    const stream = new DomainStream({
      url: "ws://test/ws",
      accountId: "acc",
      afterSeq,
      onEvent: (event) => events.push({ seq: event.seq, type: event.type }),
      onResyncRequired: (reason) => resyncs.push(reason),
      onStateChange: (state) => states.push(state),
      socketFactory: () => socket,
    });
    return { socket, events, resyncs, states, stream };
  }

  test("subscribe memakai afterSeq awal", () => {
    const { socket, stream } = setup(42);
    stream.connect();
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ op: "subscribe", accountId: "acc", afterSeq: 42 });
  });

  test("event dengan seq duplikat TIDAK diserahkan dua kali", () => {
    const { socket, events, stream } = setup(0);
    stream.connect();
    socket.open();
    socket.emit({ seq: 1, type: "account.created" });
    socket.emit({ seq: 1, type: "account.created" }); // duplikat at-least-once
    socket.emit({ seq: 2, type: "ledger.created" });
    socket.emit({ seq: 2, type: "ledger.created" });
    socket.emit({ seq: 3, type: "order.created" });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stream.lastSeq).toBe(3);
  });

  test("event dengan seq lebih kecil dari batas resume diabaikan", () => {
    const { socket, events, stream } = setup(10);
    stream.connect();
    socket.open();
    socket.emit({ seq: 5, type: "ledger.created" });
    socket.emit({ seq: 11, type: "ledger.created" });
    expect(events.map((event) => event.seq)).toEqual([11]);
  });

  test("frame non-domain (ack/op) tidak dianggap event", () => {
    const { socket, events, stream } = setup(0);
    stream.connect();
    socket.open();
    socket.emit({ op: "subscribed", accountId: "acc" });
    socket.emit({ op: "resumed", throughSeq: 0 });
    socket.emit({ op: "pong" });
    expect(events).toHaveLength(0);
  });

  test("resumeFrom menaikkan titik resume tanpa menurunkan", () => {
    const { stream } = setup(0);
    stream.resumeFrom(50);
    expect(stream.lastSeq).toBe(50);
    stream.resumeFrom(10);
    expect(stream.lastSeq).toBe(50);
  });

  test("putus dengan kode 1013 memicu resync, bukan sekadar menyambung ulang", () => {
    const { socket, resyncs, stream } = setup(7);
    stream.connect();
    socket.open();
    socket.serverClose(1013, "resync_required");
    expect(resyncs).toEqual(["resync_required"]);
    expect(stream.state).toBe("closed");
  });

  test("putus biasa menandai reconnecting dan meminta resync", () => {
    const { socket, resyncs, stream } = setup(0);
    stream.connect();
    socket.open();
    socket.serverClose(1006, "network");
    expect(resyncs).toEqual(["reconnecting"]);
    expect(stream.state).toBe("reconnecting");
  });
});

describe("stream pasar: ephemeral, tanpa seq, coalescing per kontrak", () => {
  function setup() {
    const socket = new FakeSocket();
    const events: Array<{ type: string; contract: string }> = [];
    const stream = new MarketStream({
      url: "ws://test/ws",
      onEvent: (event) => events.push({ type: event.type, contract: event.contract }),
      onStateChange: () => {},
      socketFactory: () => socket,
    });
    return { socket, events, stream };
  }

  test("hanya kontrak terlihat yang dilanggan", () => {
    const { socket, stream } = setup();
    stream.connect();
    socket.open();
    stream.setContracts(["BTC_USDT", "ETH_USDT"]);
    const subscribe = socket.sent.map((entry) => JSON.parse(entry)).find((message) => message.op === "subscribe_market");
    expect(subscribe.contracts).toEqual(["BTC_USDT", "ETH_USDT"]);
  });

  test("mengganti kontrak mengirim ulang langganan tanpa menggandakan", () => {
    const { socket, stream } = setup();
    stream.connect();
    socket.open();
    stream.setContracts(["BTC_USDT"]);
    stream.setContracts(["BTC_USDT"]);
    const subscribes = socket.sent
      .map((entry) => JSON.parse(entry))
      .filter((message) => message.op === "subscribe_market");
    expect(subscribes).toHaveLength(1);
  });

  test("event pasar diteruskan; frame non-pasar diabaikan", () => {
    const { socket, events, stream } = setup();
    stream.connect();
    socket.open();
    socket.emit({ type: "market.mark", contract: "BTC_USDT", timestamp: 1, data: { markPrice: "1" } });
    socket.emit({ seq: 5, type: "ledger.created", accountId: "a" });
    socket.emit({ op: "market_subscribed", contracts: ["BTC_USDT"] });
    expect(events).toEqual([{ type: "market.mark", contract: "BTC_USDT" }]);
  });
});

describe("state pasar", () => {
  test("mark/last/index dipisahkan dan field absen tetap null", () => {
    const base = emptyMarketState("BTC_USDT");
    const next = applyMarketEvent(
      base,
      {
        type: "market.mark",
        contract: "BTC_USDT",
        timestamp: 100,
        data: { markPrice: "80045.5", lastPrice: "80000", indexPrice: "80090.1", fundingRate: "0.0001" },
      },
      200,
    );
    expect(next.markPrice).toBe("80045.5");
    expect(next.lastPrice).toBe("80000");
    expect(next.indexPrice).toBe("80090.1");
    expect(next.markSourceTimestampMs).toBe(100);
    expect(next.receivedAtMs).toBe(200);
  });

  test("event tanpa mark tidak mengarang nilai", () => {
    const base = emptyMarketState("BTC_USDT");
    const next = applyMarketEvent(
      base,
      { type: "market.mark", contract: "BTC_USDT", timestamp: 1, data: { lastPrice: "1" } },
      2,
    );
    expect(next.markPrice).toBeNull();
    expect(next.markStatus).toBe("missing");
  });

  test("event kontrak lain tidak mengubah state kontrak terpilih", () => {
    const base = emptyMarketState("BTC_USDT");
    const next = applyMarketEvent(
      base,
      { type: "market.mark", contract: "ETH_USDT", timestamp: 1, data: { markPrice: "3000" } },
      2,
    );
    expect(next.markPrice).toBeNull();
  });

  test("book ticker hanya mengisi sisi yang ada", () => {
    const base = emptyMarketState("BTC_USDT");
    const next = applyMarketEvent(
      base,
      { type: "market.book", contract: "BTC_USDT", timestamp: 1, data: { bestBid: "79999", bestAsk: null } },
      2,
    );
    expect(next.bestBid).toBe("79999");
    expect(next.bestAsk).toBeNull();
  });

  test("mergeServerState memakai server sebagai otoritatif tanpa menghapus realtime", () => {
    const realtime = applyMarketEvent(
      emptyMarketState("BTC_USDT"),
      { type: "market.book", contract: "BTC_USDT", timestamp: 1, data: { bestBid: "79999", bestBidSize: 5, bestAsk: null, bestAskSize: null } },
      2,
    );
    const server: MarketStateDto = {
      contract: "BTC_USDT",
      markPrice: "80000",
      markSourceTimestampMs: 10,
      markStatus: "fresh",
      lastPrice: null,
      indexPrice: null,
      fundingRate: null,
      fundingNextApplyMs: null,
      bestBid: null,
      bestBidSize: null,
      bestAsk: null,
      bestAskSize: null,
      depthStatus: null,
    };
    const merged = mergeServerState(realtime, server);
    expect(merged.markPrice).toBe("80000");
    // Bid dari realtime tidak hilang karena server tidak punya nilainya.
    expect(merged.bestBid).toBe("79999");
  });
});

describe("status feed tidak bergantung pada WebSocket browser", () => {
  test("LIVE hanya bila mark segar dan feed terbuka", () => {
    expect(
      deriveFeedStatus({ mode: "live", feedState: "open", markStatus: "fresh", markReceivedAtMs: 1000, nowMs: 1100 }),
    ).toBe("LIVE");
  });

  test("mark basi → STALE walau socket 'open'", () => {
    expect(
      deriveFeedStatus({ mode: "live", feedState: "open", markStatus: "fresh", markReceivedAtMs: 1000, nowMs: 60_000 }),
    ).toBe("STALE");
    expect(
      deriveFeedStatus({ mode: "live", feedState: "open", markStatus: "stale", markReceivedAtMs: 1000, nowMs: 1100 }),
    ).toBe("STALE");
  });

  test("reconnecting dan tanpa mark", () => {
    expect(
      deriveFeedStatus({ mode: "live", feedState: "reconnecting", markStatus: "fresh", markReceivedAtMs: 1000, nowMs: 1100 }),
    ).toBe("RECONNECTING");
    expect(
      deriveFeedStatus({ mode: "live", feedState: "open", markStatus: "missing", markReceivedAtMs: null, nowMs: 1 }),
    ).toBe("OFFLINE");
    expect(
      deriveFeedStatus({ mode: "live", feedState: "closed", markStatus: "fresh", markReceivedAtMs: 1000, nowMs: 1100 }),
    ).toBe("OFFLINE");
  });

  test("mode simulasi dilabeli SIMULATION (bukan LIVE) agar tidak menyesatkan", () => {
    expect(
      deriveFeedStatus({ mode: "simulation", feedState: "open", markStatus: "fresh", markReceivedAtMs: 1, nowMs: 2 }),
    ).toBe("SIMULATION");
  });

  test("mode belum diketahui tidak pernah mengaku LIVE", () => {
    expect(
      deriveFeedStatus({ mode: null, feedState: null, markStatus: "missing", markReceivedAtMs: null, nowMs: 1 }),
    ).toBe("OFFLINE");
  });
});
