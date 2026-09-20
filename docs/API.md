# crypastra — HTTP API

Basis: `Fastify`, prefiks bisnis **`/api/v1`**. Health tidak ber-versi
(`/health/live`, `/health/ready`) dan integritas di `/api/v1/health/integrity`.

Kontrak mesin: `GET /api/v1/openapi.json`.

## Konvensi

| Hal | Aturan |
|---|---|
| Nilai finansial | **selalu string** (`"1000.00000000"`, `"80445.79"`) |
| Cacah kontrak (`size`) | string digit (`"1"`), bukan desimal |
| ID | string |
| Timestamp | epoch **milidetik** (integer), konsisten dengan domain |
| Field asing | ditolak (skema zod `.strict()`) |
| Idempotensi | `commandId` wajib pada setiap operasi yang mengubah keadaan |

Uang memakai skala kanonik 8 dp; harga/rate memakai nilai eksak (tick kontrak bisa
sampai 11 dp, mis. `SATS_USDT`). Tidak ada `Decimal`/number yang bocor ke JSON.

## Error

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "...", "details": {} } }
```

| Kondisi | HTTP | `code` |
|---|---|---|
| Body/params/query tidak valid, field asing | 400 | `VALIDATION_ERROR` |
| Semantik order tidak sah (TP salah sisi, reduce_only tanpa posisi) | 422 | `INVALID_ORDER` |
| Penarikan melebihi saldo tersedia | 422 | `INSUFFICIENT_BALANCE` |
| Resource tidak ada | 404 | `NOT_FOUND` |
| `commandId` sama dengan payload berbeda | 409 | `IDEMPOTENCY_CONFLICT` |
| Integritas akuntansi gagal | 503 | `INTEGRITY_FAILURE` |
| Fitur tidak tersedia (mis. simulasi dimatikan) | 503 | `NOT_AVAILABLE` |
| Lainnya | 500 | `INTERNAL_ERROR` (pesan digeneralisasi) |

Tidak ada stack trace, pesan SQLite, atau path database yang dikembalikan.

## Mode runtime

`createApp({ mode })` menerima `"simulation"` atau `"live"`:

| | simulation | live |
|---|---|---|
| Provider pasar | `InMemoryMarketSnapshotProvider` | `LiveMarketSnapshotProvider` (feed Gate) |
| Endpoint `/simulation/*` | aktif | **mati secara default** (404) |
| `/health/ready` | database saja | database **dan** kesehatan feed |

Nilai pasar simulasi tidak pernah dapat disuntikkan ke mode live kecuali
`enableSimulation: true` diberikan eksplisit.

## Health

| Endpoint | Arti |
|---|---|
| `GET /health/live` | proses hidup |
| `GET /health/ready` | dependency (DB) dapat dipakai |
| `GET /api/v1/health/integrity` | `integrityReport()`; **503** bila cache saldo menyimpang dari ledger |
| `GET /api/v1/market/health` | mode + kesehatan feed (state, waktu, staleness, buku belum sinkron) |

## Akun

| Endpoint | Keterangan |
|---|---|
| `POST /api/v1/accounts` | buat akun paper (idempoten) |
| `GET /api/v1/accounts/:accountId` | data akun |
| `GET /api/v1/accounts/:accountId/summary` | **read model siap-UI** |
| `POST /api/v1/accounts/:accountId/deposit` | deposit dana virtual |
| `POST /api/v1/accounts/:accountId/withdraw` | tarik dana virtual |
| `POST /api/v1/accounts/:accountId/reset` | reset saldo simulasi |

### Account summary

```json
{
  "accountId": "…",
  "name": "paper",
  "mode": "simulation",
  "baseCurrency": "USDT",
  "walletBalance": "999.99400000",
  "unrealizedPnl": "0.10000000",
  "equity": "1000.09400000",
  "availableBalance": "999.19400000",
  "reservedMargin": "0.00000000",
  "positionMargin": "0.80000000",
  "marginRatio": "0.00079992",
  "openPositionCount": 1,
  "openOrderCount": 0,
  "valuationStatus": "fresh",
  "unvaluedContracts": [],
  "latestEventSeq": 12,
  "asOf": 1726830000000
}
```

- `equity = walletBalance + unrealizedPnl`.
- `availableBalance = floor8(walletBalance − positionMargin − reservedMargin)`.
  **Unrealized profit TIDAK menambah available** (kebijakan simulator).
- `valuationStatus`: `fresh` | `stale` | `partial` (sebagian kontrak tanpa mark) |
  `unvalued` (tidak ada posisi yang bisa divaluasi).
- `latestEventSeq` adalah batas snapshot untuk resume realtime (lihat
  `docs/REALTIME.md`). Frontend tidak perlu menghitung ulang rumus akuntansi.

### Reset/reseed

Reset TIDAK menghapus atau menulis ulang ledger. Ia menulis entri `reset` bertanda
yang membawa saldo ke nilai target, sehingga audit penuh tetap ada. Reset ditolak
bila masih ada posisi terbuka atau order live (margin terkunci tidak boleh
ditinggalkan).

## Kontrak

| Endpoint | Keterangan |
|---|---|
| `GET /api/v1/contracts` | daftar kontrak (representasi internal) |
| `GET /api/v1/contracts/:contract` | detail kontrak |

Field: `quantoMultiplier`, `priceTick`, `markPriceTick`, `orderSizeMin/Max`,
`enableDecimal`, `leverageMin/Max`, `maintenanceRate`, `makerFeeRate`,
`takerFeeRate`, `fundingIntervalSeconds`. Payload mentah Gate.io tidak
dikembalikan.

## Order

| Endpoint | Keterangan |
|---|---|
| `POST /api/v1/accounts/:accountId/orders` | kirim order |
| `GET /api/v1/accounts/:accountId/orders` | daftar order (`?status=`, `?limit=`) |
| `GET /api/v1/accounts/:accountId/orders/:orderId` | detail + event lifecycle |
| `POST /api/v1/accounts/:accountId/orders/:orderId/cancel` | batalkan |
| `POST /api/v1/accounts/:accountId/orders/:orderId/evaluate` | evaluasi order resting |

Permintaan submit (memetakan langsung ke `OrderIntent` domain):

```json
{
  "commandId": "cli-0001",
  "contract": "BTC_USDT",
  "side": "buy",
  "type": "market",
  "size": "1",
  "leverage": "10",
  "limitPrice": null,
  "takeProfitPrice": "82000",
  "stopLossPrice": "78000"
}
```

- `side`: `buy` (= LONG) atau `sell` (= SHORT), mengikuti domain.
- `timeInForce` opsional (default `ioc` untuk market, `gtc` untuk limit).
- Order **market** dan limit yang menyentuh buku dieksekusi terhadap buku dari
  `MarketSnapshotProvider`. Bila belum ada buku untuk kontrak → `404`.
- Order yang ditolak (mis. margin kurang) dikembalikan `201` dengan
  `order.status = "rejected"` + `rejectReason` — penolakan adalah keadaan domain
  yang dipersist, bukan error HTTP.

## Posisi

| Endpoint | Keterangan |
|---|---|
| `GET /api/v1/accounts/:accountId/positions` | daftar posisi + valuasi mark |
| `GET /api/v1/accounts/:accountId/positions/:positionId` | detail + event |
| `POST /api/v1/accounts/:accountId/positions/:positionId/close` | tutup manual |
| `PATCH /api/v1/accounts/:accountId/positions/:positionId/protection` | ubah TP/SL |

Baris posisi sudah memuat `markPrice`, `unrealizedPnl`, `maintenanceMargin`,
`liquidationPrice`, `takeProfitPrice`, `stopLossPrice`, dan `valuationStatus`
sehingga satu baris dapat dirender tanpa memanggil endpoint lain. Posisi tanpa
mark dilaporkan `valuationStatus: "unvalued"` dengan nilai turunan `null` —
PnL tidak pernah ditebak.

`PATCH protection`: `undefined` = pertahankan, `null` = kosongkan, string = set
baru. TP/SL divalidasi terhadap sisi posisi (TP LONG harus di atas entry, dst).
Idempoten dan menulis `position_events` tipe `protection_updated`.

`POST close` memakai harga eksekusi dari kutipan server (bid untuk LONG, ask untuk
SHORT); `bidPrice`/`askPrice` dapat diberikan eksplisit untuk simulasi.

## Riwayat & ledger

| Endpoint | Paginasi |
|---|---|
| `GET /api/v1/accounts/:accountId/fills` | kursor id (`?after=<id>&limit=`) |
| `GET /api/v1/accounts/:accountId/history` | kursor id |
| `GET /api/v1/accounts/:accountId/ledger` | kursor `seq` numerik |
| `GET /api/v1/accounts/:accountId/events` | kursor `seq` numerik (outbox) |

Urutan stabil (dijamin `rowid` untuk fill/posisi dan `seq` untuk ledger/event).
Tidak ada endpoint yang mengembalikan riwayat tanpa batas; `limit` maksimum 500.

Entri ledger: `type`, `amount`, `balanceAfter`, `marginDelta`, `reservedDelta`,
`reference { type, id }`, `timestamp`.

## Read model pasar

| Endpoint | Keterangan |
|---|---|
| `GET /api/v1/market/state?contracts=A,B` | mark/last/index/funding/bid/ask + `markStatus` per kontrak; bidang yang tidak tersedia `null` |
| `GET /api/v1/market/candles?contract=&interval=5m&limit=` | candle tersimpan (hanya yang tertutup), urut naik, untuk chart |
| `GET /api/v1/market/health` | mode + kesehatan feed |

`markStatus`: `fresh` | `stale` | `missing`. Frontend memakainya untuk menandai
harga basi; nilai basi TIDAK pernah disajikan sebagai terkini.

## Endpoint simulasi (Phase 5)

Hanya untuk lingkungan simulasi; dapat dimatikan dengan `enableSimulation: false`.

| Endpoint | Keterangan |
|---|---|
| `POST /api/v1/simulation/market` | suntik mark + bid/ask (+ funding) ke provider server |
| `POST /api/v1/accounts/:accountId/process-mark/:contract` | proses mark yang SUDAH ada di server |

Endpoint ini TIDAK memutasi posisi secara langsung: ia hanya mengisi/ memproses
sumber pasar, dan efek ekonominya berjalan lewat `MarkToMarketService` yang sama
dengan yang akan dipakai feed nyata.

## Ukuran kontrak pada API (Phase 11.5)

`size` pada `POST /accounts/:accountId/orders` adalah **string desimal positif**
(mis. `"1"`, `"125"`, `"1.25"`). Ukuran numerik JSON (`1.25` sebagai number)
ditolak — nilai finansial tetap string.

DTO hanya memeriksa bentuk sintaktis. Apakah pecahan diterima adalah aturan
kontrak:

- `enable_decimal=false` → ukuran pecahan menghasilkan order `rejected`
  (`rejectReason` menyebut `integer`), HTTP 201 dengan `order.status="rejected"`
  (penolakan terekam untuk audit, bukan error HTTP).
- `enable_decimal=true` → ukuran pecahan dalam `[orderSizeMin, orderSizeMax]`
  diterima dan terisi.
