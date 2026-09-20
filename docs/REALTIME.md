# crypastra — Protokol Realtime

WebSocket: `ws://<host>/ws`

Sumber kebenaran realtime adalah **tabel `domain_events`** (outbox transaksional),
bukan memori proses. WebSocket hanya sarana pengiriman.

## Dua kelas aliran (jangan dicampur)

| Kelas | Contoh | Sifat |
|---|---|---|
| **Peristiwa domain** | `order.*`, `fill.created`, `position.*`, `ledger.created`, `funding.applied`, `account.*` | Durable, masuk outbox DB, dapat di-resume lewat `seq` |
| **Peristiwa pasar** | ticker, mark, book, candle | Ephemeral, frekuensi tinggi, TIDAK dipersist per tick (Phase 6) |

Tick pasar tidak pernah masuk outbox: itu akan membuat jutaan baris DB. Phase 5
belum mengalirkan data pasar sama sekali.

## Amplop event

```json
{
  "seq": 1234,
  "type": "position.closed",
  "accountId": "…",
  "aggregateType": "position",
  "aggregateId": "…",
  "timestamp": 1726830000000,
  "data": { "reason": "take_profit", "executionPrice": "81600", "realizedPnl": "0.15000000" }
}
```

`timestamp` adalah epoch milidetik. Nilai finansial di dalam `data` juga string.

Tipe yang diterbitkan: `account.created`, `account.updated`, `order.created`,
`order.updated`, `order.filled`, `order.cancelled`, `position.opened`,
`position.updated`, `position.closed`, `position.liquidated`, `fill.created`,
`ledger.created`, `funding.applied`.

## Urutan

`seq` adalah **satu urutan global monoton** (INTEGER PRIMARY KEY AUTOINCREMENT)
lintas seluruh agregat. Ini yang memberi arti tepat pada `afterSeq`.

`order_events`, `position_events`, dan `ledger` tetap punya urutannya sendiri untuk
audit per-agregat; klien realtime TIDAK memakainya.

Karena `seq` global, stream satu akun boleh melompati nomor milik akun lain
(mis. klien akun B dapat 2, lalu 5 bila 3–4 milik akun lain). Itu normal.

## Pesan klien

```json
{ "op": "subscribe", "accountId": "…", "afterSeq": 100 }
{ "op": "unsubscribe" }
{ "op": "ping" }
```

Field asing ditolak; pesan tidak valid dibalas
`{"op":"error","code":"VALIDATION_ERROR",...}` tanpa memutus koneksi.

## Alur langganan & resume

```
klien konek
   ↓
{ op: "subscribe", accountId, afterSeq: N }
   ↓
{ op: "subscribed", accountId, afterSeq: N }     ← langganan aktif
   ↓
replay event seq > N (berurutan, dibatasi batch)
   ↓
{ op: "resumed", accountId, throughSeq: M }      ← batas replay
   ↓
event baru mengalir
```

## Snapshot + stream tanpa celah (penting)

```
GET /api/v1/accounts/{id}/summary   → { …, latestEventSeq: N }
   ↓  (event boleh terjadi di sini — tidak hilang)
WS: { op: "subscribe", accountId, afterSeq: N }
   ↓
terima semua event dengan seq > N
```

`latestEventSeq` dibaca dalam **transaksi yang sama** dengan saldo, sehingga
selalu merupakan batas yang konsisten: apa pun yang terjadi setelah pembacaan
pasti memiliki `seq > N` dan akan dikirim saat replay. Test
`tests/phase5-realtime-ws.test.ts` menaruh sebuah deposit tepat di celah ini dan
memverifikasi event-nya tetap tiba.

## Semantik pengiriman

- **At-least-once.** Transport dapat menggandakan; klien WAJIB melakukan dedupe
  berdasarkan `seq` (dan boleh memakainya untuk mengurutkan).
- Tidak ada event yang dianggap baru bila `seq`-nya sudah pernah dilihat klien.

## Backpressure

- Antrean keluar per koneksi dibatasi (`maxQueue`, default 1000 event).
- Pengurasan berhenti bila buffer socket mencapai `highWaterMarkBytes`
  (default 1 MiB), sehingga antrean benar-benar menumpuk di server.
- Klien yang melewati batas **diputus dengan kode `1013` dan alasan
  `resync_required`**, bukan dibiarkan menelan memori server.
- Setelah diputus, klien harus mengambil ulang snapshot (`GET /summary`) dan
  subscribe dengan `afterSeq` terbaru.
- Ukuran pesan klien dibatasi (`maxPayloadBytes`, default 64 KiB).

## Stream pasar EPHEMERAL (Phase 6)

Selain peristiwa domain, klien dapat berlangganan keadaan pasar terbaru:

```json
{ "op": "subscribe_market", "contracts": ["BTC_USDT"] }
{ "op": "unsubscribe_market" }
```

Balasan: `{"op":"market_subscribed","contracts":[...]}`.

Frame pasar **tidak punya `seq`** dan **tidak dapat di-resume**:

```json
{ "type": "market.mark",   "contract": "BTC_USDT", "timestamp": 1726830000000, "data": { "markPrice": "80496.5", "indexPrice": "80530.9", "lastPrice": "80506.9", "fundingRate": "0.000047" } }
{ "type": "market.book",   "contract": "BTC_USDT", "timestamp": ..., "data": { "bestBid": "80506.8", "bestBidSize": 120, "bestAsk": "80506.9", "bestAskSize": 200 } }
{ "type": "market.candle", "contract": "BTC_USDT", "timestamp": ..., "data": { "interval": "5m", "openTime": 1789910400, "close": "80496.5", "closed": false } }
{ "type": "market.status", "contract": "BTC_USDT", "timestamp": ..., "data": { "state": "open" } }
```

Perbedaan mendasar dengan peristiwa domain:

| | Peristiwa domain | Peristiwa pasar |
|---|---|---|
| Amplop | `seq`, `type`, `aggregateType`, … | `type`, `contract`, `timestamp`, `data` |
| Durabel | ya (`domain_events`, outbox) | **tidak** (tidak pernah ditulis ke DB) |
| Resume | ya, via `afterSeq` | tidak |
| Beban | tidak pernah dibuang | **di-coalesce**: hanya keadaan terbaru per (kontrak, jenis) |
| Backpressure | klien lambat diputus `1013` | frame lama digantikan yang baru |

Coalescing berarti klien boleh kehilangan keadaan ANTARA; itu disengaja. Untuk
keputusan ekonomi selalu gunakan peristiwa domain.

## Batas fase ini

- Belum ada autentikasi/otorisasi per akun; ini akan menjadi batas tersendiri.
- Belum ada aliran data pasar: ticker/mark/book menyusul di Phase 6 sebagai aliran
  ephemeral terpisah, bukan lewat outbox ini.
