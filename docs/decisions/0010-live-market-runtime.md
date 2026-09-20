# 0010 — Runtime pasar live: koneksi Gate, MarketState, buku kedalaman, stream ephemeral

- Status: diterima
- Tanggal: 2026-09-20
- Melanjutkan: 0003 (mark price), 0009 (API/outbox/realtime)

## Konteks

Phase 6 menyambungkan feed pasar publik Gate.io ke paper exchange yang sudah ada.
Requirement yang membentuk keputusan:

- Dokumentasi resmi Gate tidak dapat diakses dari environment ini; fakta protokol
  berasal dari probe langsung (Phase 0) dan diverifikasi ulang di Phase 6.
- Peristiwa domain (outbox) dan peristiwa pasar (frekuensi tinggi) adalah dua
  kelas yang berbeda dan tidak boleh dicampur.
- Mark price adalah safety-critical; staleness harus eksplisit.
- Buku yang diketahui berlubang TIDAK boleh dipakai untuk eksekusi.

## Keputusan

### 1. `futures.book_ticker` sebagai sumber kutipan eksekusi

Ditemukan saat smoke test pertama: `bestBid`/`bestAsk` kosong karena runtime hanya
berlangganan `futures.tickers` dan `futures.candlesticks`. Ditambahkan channel
ringan `futures.book_ticker` dengan event ternormalisasi baru `book_ticker`
(`{contract, bestBid, bestBidSize, bestAsk, bestAskSize, updateId, eventTsMs}`).

**`futures.order_book_update` TIDAK dipakai untuk top-of-book**: payload-nya
adalah perubahan level dan sering kosong (`"a":[], "b":[]` pada probe Phase 0),
sehingga menurunkan best bid/ask darinya salah. Ia hanya dipakai untuk buku
kedalaman lokal pada kontrak yang dikonfigurasi.

Kutipan hanya tersedia bila KEDUA sisi ada; kalau tidak → `null`, bukan karangan.

### 2. Kelas langganan

| Kelas | Channel | Untuk |
|---|---|---|
| CORE | `futures.tickers`, `futures.book_ticker` | semua kontrak terlacak (mark, funding, kutipan) |
| CANDLE | `futures.candlesticks` 5m | semua kontrak terlacak |
| DEPTH | `futures.order_book_update` | HANYA kontrak di `depthContracts` |

Seluruh 997 kontrak tidak pernah dilanggan ke channel frekuensi tinggi. Langganan
yang DIINGINKAN disimpan terpisah dari socket (`#desired*`), sehingga reconnect
memulihkannya tanpa menggandakan langganan logis (dedupe di provider).

### 3. Reconnect dengan backoff, timer dapat disuntik

`#scheduleReconnect()` memakai backoff eksponensial terbatas
(`reconnectBaseMs * 2^(n-1)`, dibatasi `reconnectMaxMs`), bukan loop rapat.
Timer dapat disuntik (`timers`) sehingga perilakunya dapat diuji deterministik.
Backoff direset setelah koneksi terbuka; kegagalan reconnect berikutnya
menjadwalkan ulang.

### 4. MarketState milik server

`MarketStateStore` menyimpan per kontrak: last/mark/index beserta waktunya,
funding (rate, next apply, interval), best bid/ask + ukuran + update id, candle
5m terbaru dan terakhir tertutup, tampilan status buku, dan `lastReceivedAtMs`.

- Semua nilai finansial `Decimal`/string — tidak pernah `number`.
- **Waktu exchange (`sourceTimestampMs`) dan waktu terima (`receivedAtMs`)
  disimpan terpisah.** Staleness dinilai terhadap jam exchange, sehingga
  keterlambatan sumber terlihat apa adanya.
- Field yang tidak ada tetap `null`. Mark tidak pernah diisi dari last/index.

### 5. Provider live memenuhi interface Phase 5

`LiveMarketSnapshotProvider implements MarketSnapshotProvider` — DTO dan pemanggil
service tidak berubah. Mode simulasi memakai `InMemoryMarketSnapshotProvider`;
keduanya dapat ditukar tanpa menyentuh aplikasi.

### 6. Buku kedalaman lokal dengan algoritma Gate

`DepthBook` menerapkan prosedur resmi: tampung update sambil `syncing`, ambil
snapshot REST (`with_id`), buang update `u <= id`, cari update yang memenuhi
`U <= id+1 <= u`, terapkan berurutan dengan `U == prev_u + 1`, dan pada gap →
`unsynced` + resync.

- Ukuran level adalah **ABSOLUT**, bukan delta; `size == 0` menghapus level.
- Snapshot REST yang tidak terurut ditolak.
- Pengurutan memakai perbandingan `Decimal` (bukan float/string).
- `toBookSnapshot()` mengembalikan `null` kecuali `synced`, jadi eksekusi tidak
  pernah memakai buku yang berlubang.

Bug yang ditemukan lewat test: setelah snapshot tiba tanpa update yang menyambung,
update berikutnya tertahan selamanya di buffer. Diperbaiki dengan
`#activateFromBuffer()` yang dicoba setiap kali update/snapshot masuk.

Ukuran level disimpan sebagai `number` (cacah kontrak bulat, sesuai
`BookLevel.size` di domain), bukan `Decimal` — menghindari konversi di jalur uang
dan mematuhi aturan pembulatan terpusat Phase 2.

### 7. Pemroses risiko berkadens + coalescing

`MarketRuntime` menyimpan HANYA mark terbaru per kontrak (`#pendingRisk`) dan
memprosesnya pada interval `riskIntervalMs` (dapat dikonfigurasi). Mark yang
tertimpa dihitung sebagai `marksCoalesced`. Konsekuensi yang didokumentasikan:
TP/SL/likuidasi dievaluasi pada mark TERAKHIR yang tersedia saat pemrosesan,
bukan pada setiap paket — trade-off yang disengaja antara kesetiaan dan beban.

`LiveRiskProcessor` hanya memproses akun yang punya posisi terbuka pada kontrak
itu (`PositionRepository.listOpenByContract`), bukan seluruh akun.

### 8. Idempotensi runtime dengan id deterministik

Id perintah pemroses risiko diturunkan dari identitas mark, bukan UUID:

```
live-mark:{accountId}:{contract}:{sourceTimestampMs}:{markPrice}
```

Update Gate yang terduplikasi atau diputar ulang setelah reconnect menghasilkan id
yang sama, sehingga funding/likuidasi/TP-SL/ledger tidak berlipat. Diuji: mark sama
dua kali → satu penutupan, satu entri `pnl_realized`.

Ini juga menutup follow-up Phase 5: jalur submit order kini menghitung
`request_hash` dari intent ternormalisasi (seluruh field yang mengubah perilaku
ekonomi; desimal dinormalkan sehingga `1` dan `1.0` tidak dianggap berbeda).
Buku pasar TIDAK masuk sidik jari karena ia keadaan ambien, bukan bagian perintah.

### 9. Stream pasar ephemeral

Event pasar dikirim dengan amplop berbeda dan **TANPA `seq`**:
`market.mark`, `market.book`, `market.candle`, `market.status`. Mereka:

- TIDAK pernah ditulis ke `domain_events` (diuji),
- TIDAK dapat di-resume,
- **boleh di-coalesce**: hub menyimpan hanya frame terbaru per `(kontrak, jenis)`
  per koneksi, sehingga klien lambat tidak menumpuk memori server.

Peristiwa domain tetap: ber-`seq`, resumable, outbox transaksional, tidak pernah
dibuang.

### 10. Kebijakan persistensi

| Data | Disimpan? |
|---|---|
| Candle 5m **tertutup** | ya (`CandleRepository`, Phase 8 akan menambah replay) |
| Candle berjalan | tidak (hanya di MarketState) |
| Tick mark / ticker | **tidak** |
| Book ticker / depth delta | **tidak** |
| Observasi funding | belum dipersist di Phase 6 (dicatat sebagai pekerjaan Phase 8) |

Alasan: replay belum dibangun, dan menulis setiap tick akan membuat jutaan baris.

### 11. Mode dan readiness

`mode: "simulation" | "live"`. Mode `live` mematikan endpoint simulasi secara
default dan membuat `/health/ready` mempertimbangkan kesehatan feed: proses hidup,
database siap, dan feed pasar siap dilaporkan terpisah.

### 12. Batas determinisme

Ingesti live nondeterministik; PEMROSESAN ternormalisasi tetap deterministik.
Diberikan urutan event ternormalisasi yang sama + DB awal sama + `Clock` sama,
MarketState dan efek ekonomi yang dihasilkan sama. Diuji dengan provider palsu
deterministik; ini menyiapkan Phase 8.

## Konsekuensi

- Adapter menambah `subscribeBookTicker`, `onStateChange`, `lastMessageAtMs`,
  `desiredSubscriptions`, dan event `book_ticker`.
- Runtime tidak pernah menghitung efek ekonomi sendiri; seluruh efek lewat
  `MarkToMarketService`/`OrderService` (batas Phase 5 tetap utuh).
- Belum ada replay provider dan belum ada persistensi observasi funding.

## Verifikasi

- `bun test` → 538 pass (493 Phase 0–5 + 45 Phase 6), 0 fail.
- `bun run check` → core build, adapters check, server check hijau.
- Pemindaian unused/dead-code bersih (core, adapters, server).
- Smoke live (opt-in, jaringan): mark segar ~1.7s, bestBid 80506.8 / bestAsk
  80506.9 dengan bid < ask, candle 5m terbaru, funding diteruskan.
- Smoke paper (opt-in, jaringan): order PAPER terisi di kutipan publik, fee
  terpotong, posisi terbuka, ditutup manual, integritas cache==ledger OK.
