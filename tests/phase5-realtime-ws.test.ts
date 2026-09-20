import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { createAccountViaApi, injectMarket, setupApi, type ApiHarness } from "./helpers/api.js";

const harnesses: ApiHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

interface Wire {
  readonly socket: WebSocket;
  readonly messages: any[];
  waitFor(predicate: (message: any) => boolean, timeoutMs?: number): Promise<any>;
  send(value: unknown): void;
  close(): Promise<void>;
}

function connect(wsUrl: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const messages: any[] = [];
    const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = [];

    socket.on("message", (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString("utf8"));
      messages.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]!;
        if (waiter.predicate(parsed)) {
          waiters.splice(i, 1);
          waiter.resolve(parsed);
        }
      }
    });
    socket.on("open", () =>
      resolve({
        socket,
        messages,
        send: (value) => socket.send(JSON.stringify(value)),
        waitFor(predicate, timeoutMs = 3000) {
          const existing = messages.find(predicate);
          if (existing !== undefined) {
            return Promise.resolve(existing);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("timeout menunggu pesan WS")), timeoutMs);
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timer);
                res(message);
              },
            });
          });
        },
        close: () =>
          new Promise<void>((res) => {
            socket.once("close", () => res());
            socket.close();
          }),
      }),
    );
    socket.on("error", reject);
  });
}

async function setupWithServer(): Promise<{
  h: ApiHarness;
  accountId: string;
  wsUrl: string;
  hub: NonNullable<Awaited<ReturnType<ApiHarness["listen"]>>["hub"]>;
  closeServer(): Promise<void>;
}> {
  const h = setupApi();
  harnesses.push(h);
  await injectMarket(h, "BTC_USDT", "80000");
  const accountId = await createAccountViaApi(h);
  const server = await h.listen(true);
  if (server.hub === null) {
    throw new Error("hub tidak aktif");
  }
  return {
    h,
    accountId,
    wsUrl: server.url.replace("http://", "ws://") + "/ws",
    hub: server.hub,
    closeServer: server.close,
  };
}

describe("22. WebSocket: subscribe, replay, live", () => {
  test("subscribe lalu menerima event baru sebagai frame ber-envelope", async () => {
    const { h, accountId, wsUrl, hub, closeServer } = await setupWithServer();
    const wire = await connect(wsUrl);
    wire.send({ op: "subscribe", accountId, afterSeq: 0 });
    const ack = await wire.waitFor((m) => m.op === "subscribed");
    expect(ack.accountId).toBe(accountId);

    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d1", amount: "10" });
    hub.tick();

    const event = await wire.waitFor((m) => m.type === "ledger.created");
    expect(typeof event.seq).toBe("number");
    expect(event.accountId).toBe(accountId);
    expect(event.aggregateType).toBe("ledger");
    expect(typeof event.timestamp).toBe("number");
    expect(event.data).toBeDefined();

    wire.socket.close();
    await closeServer();
  });

  test("resume dengan afterSeq tidak mengirim ulang event lama", async () => {
    const { h, accountId, wsUrl, hub, closeServer } = await setupWithServer();
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d1", amount: "10" });
    const events = await h.request("GET", `/api/v1/accounts/${accountId}/events`);
    const cursor = events.json.latestEventSeq as number;

    // Event setelah kursor.
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "d2", amount: "20" });
    const latest = await h.request("GET", `/api/v1/accounts/${accountId}/events`);
    const expectedNew = latest.json.events.filter((event: any) => event.seq > cursor).length;
    expect(expectedNew).toBeGreaterThan(0);

    const wire = await connect(wsUrl);
    wire.send({ op: "subscribe", accountId, afterSeq: cursor });
    await wire.waitFor((m) => m.op === "resumed");
    hub.tick();
    await wire.waitFor((m) => typeof m.seq === "number" && m.seq > cursor);

    const seqs = wire.messages.filter((m) => typeof m.seq === "number").map((m) => m.seq);
    for (const seq of seqs) {
      expect(seq).toBeGreaterThan(cursor);
    }
    // Tidak ada duplikat seq pada pengiriman ini.
    expect(new Set(seqs).size).toBe(seqs.length);

    wire.socket.close();
    await closeServer();
  });

  test("snapshot + afterSeq menutup celah race: event saat 'GET snapshot' tetap diterima", async () => {
    const { h, accountId, wsUrl, hub, closeServer } = await setupWithServer();

    // 1. Snapshot (server mengembalikan batas seq).
    const summary = await h.request("GET", `/api/v1/accounts/${accountId}/summary`);
    const boundary = summary.json.latestEventSeq as number;

    // 2. Event terjadi DI ANTARA snapshot dan subscribe.
    await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, { commandId: "race", amount: "77" });

    // 3. Klien subscribe memakai batas snapshot.
    const wire = await connect(wsUrl);
    wire.send({ op: "subscribe", accountId, afterSeq: boundary });
    const depositEvent = await wire.waitFor(
      (m) => m.type === "account.updated" && m.data?.reason === "deposit",
    );
    expect(depositEvent.seq).toBeGreaterThan(boundary);
    expect(depositEvent.data.amount).toBe("77.00000000");

    wire.socket.close();
    await closeServer();
  });

  test("pesan klien tidak valid dibalas error, koneksi tetap hidup", async () => {
    const { wsUrl, accountId, closeServer } = await setupWithServer();
    const wire = await connect(wsUrl);
    wire.send({ op: "tidak-dikenal" });
    const error = await wire.waitFor((m) => m.op === "error");
    expect(error.code).toBe("VALIDATION_ERROR");

    // Masih bisa subscribe setelahnya.
    wire.send({ op: "subscribe", accountId, afterSeq: 0 });
    await wire.waitFor((m) => m.op === "subscribed");
    wire.socket.close();
    await closeServer();
  });

  test("ping dibalas pong", async () => {
    const { wsUrl, closeServer } = await setupWithServer();
    const wire = await connect(wsUrl);
    wire.send({ op: "ping" });
    const pong = await wire.waitFor((m) => m.op === "pong");
    expect(pong.op).toBe("pong");
    wire.socket.close();
    await closeServer();
  });

  test("bukan JSON dibalas error tanpa memutus koneksi", async () => {
    const { wsUrl, closeServer } = await setupWithServer();
    const wire = await connect(wsUrl);
    wire.socket.send("ini bukan json");
    const error = await wire.waitFor((m) => m.op === "error");
    expect(error.code).toBe("VALIDATION_ERROR");
    wire.socket.close();
    await closeServer();
  });
});

describe("24. backpressure", () => {
  test("klien terlalu lambat diputus dengan resync_required, bukan menumpuk memori", async () => {
    const h = setupApi();
    harnesses.push(h);
    await injectMarket(h, "BTC_USDT", "80000");
    const accountId = await createAccountViaApi(h);
    // maxQueue kecil (5) dan pengurasan dimatikan (`highWaterMarkBytes: 0`)
    // supaya antrean benar-benar menumpuk di server secara deterministik.
    const server = await h.listen(true, { maxQueue: 5, highWaterMarkBytes: 0 });
    const wsUrl = server.url.replace("http://", "ws://") + "/ws";

    const wire = await connect(wsUrl);
    // Daftarkan listener close SEBELUM memicu penumpukan: hub dapat memutus
    // koneksi kapan saja lewat timer internalnya.
    const closed = new Promise<number>((resolve) => {
      wire.socket.on("close", (code: number) => resolve(code));
    });
    wire.send({ op: "subscribe", accountId, afterSeq: 0 });
    await wire.waitFor((m) => m.op === "subscribed");

    // Buat jauh lebih banyak event daripada kapasitas antrean, lalu paksa
    // polling supaya antrean server melewati batas.
    for (let i = 0; i < 12; i += 1) {
      await h.request("POST", `/api/v1/accounts/${accountId}/deposit`, {
        commandId: `bp-${i}`,
        amount: "1",
      });
    }
    server.hub!.tick();

    expect(await closed).toBe(1013);
    expect(server.hub!.connectionCount()).toBe(0);

    await server.close();
  });

  test("koneksi aktif dilacak dan berkurang setelah klien menutup", async () => {
    const { wsUrl, accountId, hub, closeServer } = await setupWithServer();
    const wire = await connect(wsUrl);
    wire.send({ op: "subscribe", accountId, afterSeq: 0 });
    await wire.waitFor((m) => m.op === "subscribed");
    expect(hub.connectionCount()).toBe(1);
    await wire.close();
    // Beri kesempatan event 'close' diproses.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.connectionCount()).toBe(0);
    await closeServer();
  });
});
