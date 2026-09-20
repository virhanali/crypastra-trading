# 0009 — API aplikasi, outbox transaksional, dan protokol realtime

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0005 (persistensi), 0006 (matematika), 0007 (siklus order), 0008 (runtime risiko)

## Konteks

Phase 5 mengekspos paper exchange lewat HTTP `Fastify` + WebSocket. Requirement
yang membentuk keputusan:

1. HTTP/WS adalah batas aplikasi: tidak ada matematika finansial atau mutasi tabel
   langsung di rute.
2. Semua nilai finansial keluar sebagai STRING.
3. Semua endpoint yang mengubah keadaan idempoten lewat `commandId`.
4. Realtime butuh SATU urutan global yang dapat di-resume, bukan gabungan urutan
   tabel yang tidak berhubungan.
5. Perubahan keadaan dan event publiknya harus commit bersama (transactional outbox).

## Keputusan

### 1. Rute hanya memanggil service

`createApp()` merakit Fastify + service (`AccountService`, `OrderService`,
`PositionService`, `MarkToMarketService`) + repository baca. Rute melakukan
validasi zod, memanggil service, dan menyerahkan hasil ke serializer. PnL, fee,
margin, transisi posisi, matching, likuidasi, dan funding tetap di
`packages/core` + service; rute tidak menghitung apa pun.

### 2. Uang selalu string

`api/dto.ts` adalah satu-satunya tempat serialisasi. `encodeMoney` untuk uang
(kanonik 8 dp) dan `encodeDecimalString` untuk harga/rate. `Number()`,
`parseFloat`, dan `.toNumber()` dilarang di `apps/server/src/api` (ditegakkan
test), dan test lain memeriksa SETIAP respons endpoint bahwa field finansial
bertipe string. Bahkan payload audit `position_events.detail` memakai string
untuk cacah kontrak supaya klien bisa memakai satu aturan.

Koersi input (`size`) dilakukan zod setelah regex ketat, bukan oleh kode kita.

### 3. Idempotensi + deteksi konflik

`trade_commands` bertambah kolom `request_hash` (sidik jari payload deterministik).
- commandId sama + payload sama → hasil lama dikembalikan, nol efek baru.
- commandId sama + payload BERBEDA → `409 IDEMPOTENCY_CONFLICT`.
- Baris lama tanpa hash (pra-Phase 5) diperlakukan cocok agar data historis tidak
  tiba-tiba dianggap konflik.

`AccountService` mengecek perintah DULU sebelum membuat akun, sehingga retry
pembuatan akun tidak pernah menghasilkan akun kedua.

### 4. Outbox transaksional + urutan global

Tabel `domain_events` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT) adalah outbox.
`DomainEventRepository.append` TIDAK membuka transaksi sendiri: pemanggil wajib
sudah berada di dalam transaksi yang sama dengan perubahan finansialnya.

`OrderService` dan `MarkToMarketService` merutekan seluruh penulisan ledger lewat
`#ledgerPost()` dan seluruh perubahan status lewat helper yang juga menulis event,
jadi tidak mungkin ada perubahan keadaan tanpa event atau sebaliknya. Test
injeksi kegagalan membuktikan rollback tidak meninggalkan event yang commit.

`seq` adalah urutan global lintas agregat. `order_events`, `position_events`, dan
`ledger` tetap punya urutannya sendiri untuk audit per-agregat.

### 5. Audit `source` tetap di luar intent

`OrderIntent` tidak diberi field asal. Label produsen tetap opsional
(`auditSource`) dan hanya ditulis ke `orders.source`, tidak pernah dibaca logika
ekonomi.

### 6. Snapshot + resume bebas race

`GET /summary` mengembalikan `latestEventSeq` yang dibaca dalam transaksi yang
SAMA dengan saldo. Klien memakai nilai itu sebagai `afterSeq` saat subscribe,
sehingga event yang terjadi di antara GET dan subscribe tetap terkirim. Test
khusus menaruh sebuah deposit di celah tersebut dan memverifikasi event-nya tiba.

Semantik pengiriman: **at-least-once**; `seq` adalah kunci dedupe klien. `seq`
bersifat global, jadi stream satu akun boleh melompati nomor milik akun lain.

### 7. Backpressure nyata

Antrean keluar per koneksi dibatasi (`maxQueue`), dan pengurasan BERHENTI bila
`bufferedAmount` socket mencapai ambang (`highWaterMarkBytes`, default 1 MiB).
Tanpa ambang itu, menulis ke socket lambat hanya memindahkan masalah ke buffer
internal `ws` dan memori tetap tumbuh tanpa batas — ini ditemukan saat test
backpressure pertama tidak pernah memicu pemutusan. Klien yang melewati batas
diputus dengan kode `1013` dan alasan `resync_required`.

### 8. Peristiwa domain vs aliran pasar

Outbox durable hanya untuk peristiwa FINANSIAL (order, fill, posisi, ledger,
funding, likuidasi). Tick pasar (ticker/mark/book/candle) TIDAK masuk outbox:
itu aliran ephemeral yang akan dimiliki Phase 6 tanpa persistensi per tick.

### 9. Pemisahan provider pasar

`MarketSnapshotProvider` adalah sumber nilai pasar milik server. Phase 5 memakai
`InMemoryMarketSnapshotProvider` yang diisi endpoint simulasi; Phase 6 akan
menggantinya dengan MarketState live tanpa mengubah pemanggil. API baca TIDAK
menerima mark price dari klien.

### 10. Urutan stabil memakai `rowid`

Ditemukan saat uji determinisme: dengan clock yang disuntik konstan, urutan
`ORDER BY ts DESC, id DESC` menjadi TIDAK deterministik karena id acak. Semua
daftar (order, fill, posisi) sekarang diurutkan memakai `rowid` SQLite yang
monoton per penyisipan, sehingga paginasi dan replay stabil.

## Konsekuensi

- Migrasi `0004` (tabel `domain_events` + `trade_commands.request_hash`) dan `0005`
  (trigger append-only `domain_events`). Keduanya aman untuk DB terisi.
- `domain_events` append-only di level database; koreksi = event baru.
- Endpoint simulasi dapat dimatikan (`enableSimulation: false`).
- OpenAPI ringkas disajikan di `/api/v1/openapi.json` sebagai satu kontrak kanonik
  tanpa codegen.
- Belum ada auth/OAuth: kepemilikan akun adalah batas fase berikutnya.

## Verifikasi

- `bun test` → 493 pass (419 Phase 0–4 tanpa perubahan + 74 Phase 5), 0 fail.
- `bun run check` → core build, adapters check, server check hijau.
- Pemindaian unused/dead-code bersih.
- `bun run db:migrate` dua kali pada DB kosong → 17 tabel, 6 migrasi, idempoten.
