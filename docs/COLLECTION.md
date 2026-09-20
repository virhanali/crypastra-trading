# Pengumpulan data (Phase 13)

Empat mode yang dipisah tegas:

| Mode | Perintah | Jaringan | Catatan |
|---|---|---|---|
| **RECORD ONLY** | `bun run record:market` | publik Gate | hanya rekam; tidak ada Jev |
| **RECORD + COLLECT** | `record:market` + `CRYPASTRA_JEV=1` | publik Gate + Jev | kolektor asinkron |
| **BACKFILL** | `bun run jev:backfill -- <session>` | Jev saja | tidak butuh pasar hidup |
| **REPLAY** | `evaluate:baseline` / `evaluate:ab` | **nol** | hanya evaluasi tercache |

## Perekam pasar

`bun run record:market [--contracts BTC_USDT,ETH_USDT] [--seconds 3600] [--db <path>]`

- Provider pasar **publik** Gate (`GateioMarketDataProvider`) + `MarketRecorder` Phase 8.
- Tanpa API key, tanpa kanal privat, tanpa order.
- Universe default kecil (BTC_USDT, ETH_USDT) — **tidak** merekam ~1000 kontrak.
- Startup mencetak session id, kontrak, waktu mulai, mode, timeframe, lokasi storage.
- Statistik periodik: elapsed, observasi per jenis, bytes, kandidat yang dilewati.
- `SIGINT`/`SIGTERM` menutup sesi dengan benar (`completed`).

### Resumability

Saat start, bila ada sesi `recording` yang aktif:

- universe kontrak **identik** → sesi itu **dilanjutkan**;
- universe berbeda → sesi lama ditutup `aborted`, sesi baru dibuat.

Konfigurasi berbeda tidak pernah ditambahkan diam-diam ke sesi lama.

### Kebijakan storage

`MarketRecorder` sudah menerapkan: mark sesuai kebijakan, quote hanya saat
berubah bermakna, funding saat perubahan/aplikasi, candle **tertutup saja**.
Tidak ada purge destruktif otomatis. `dataset:status` melaporkan `bytes`,
distribusi observasi, dan jumlah kandidat yang dilewati karena tidak berubah.
Kebijakan ini tidak melemahkan kebenaran replay: observasi yang dilewati memang
identik dengan yang terakhir tersimpan.

## Kolektor Jev asinkron

`LiveJevCollector` (`apps/server/src/treatment/live-jev-collector.ts`).

Jaminan utama: **`MarketRuntime`, pemrosesan risiko, TP/SL, dan likuidasi tidak
pernah menunggu Jev.** `enqueue` sinkron; bila antrean penuh permintaan
**dibuang** dengan pencatatan `QUEUE_FULL` / `queueDropped`, bukan memblokir
ingest.

| Parameter | Env | Default |
|---|---|---|
| kapasitas antrean | `CRYPASTRA_JEV_QUEUE` | 200 |
| konkurensi worker | `CRYPASTRA_JEV_CONCURRENCY` | 2 |
| permintaan per menit | `CRYPASTRA_JEV_RPM` | 60 |
| timeout per permintaan | `CRYPASTRA_JEV_TIMEOUT_MS` | 5000 |
| percobaan ulang maksimum | — | 2 |

Kapasitas mencakup pekerjaan yang **sedang berjalan**, bukan hanya antrean.

### Kebijakan kegagalan (§11)

| Kondisi | Perlakuan |
|---|---|
| timeout / 429 / 5xx / jaringan | **retry terbatas** (`maxRetries`), backoff `retryDelayMs × attempt` |
| output terstruktur cacat | **tidak** diulang; dicatat `invalid` |
| auth/config (401/403) | **fatal**; health kolektor ditandai rusak, tanpa retry |

Percobaan ulang **tidak pernah menggandakan evaluasi**: identitas cache Phase 12
otoritatif, dan evaluator yang sudah berhasil tersimpan sehingga pengulangan
hanya mengambil yang gagal. Tidak ada retry tak terbatas.

### Kelengkapan kandidat

Status per kandidat: `complete` (seluruh evaluator wajib berhasil), `partial`,
`missing`, `invalid`, `unavailable`. **3 dari 4 evaluator bukan `complete`**, dan
perlakuan tidak dijalankan tanpa kelengkapan.

### Status koleksi

`queued`, `inFlight`, `completed`, `cacheHits`, `cacheMisses`, `success`,
`invalid`, `unavailable`, `timeout`, `rateLimited`, `retryCount`, `queueDropped`,
`fatalErrors`. Dicetak di statistik perekam dan tersedia lewat API service.

## Backfill

`bun run jev:backfill -- <sessionId> [--db <path>]`

Rekaman → fitur/scanner deterministik → input hash kandidat → periksa cache →
ambil **hanya yang hilang** → persist. Aman diulang: kandidat yang sudah lengkap
dilewati. Melaporkan kandidat, sudah lengkap, belum lengkap, terkumpul, gagal,
sisa.

Alur yang didukung: **rekam pasar dulu, kumpulkan Jev kemudian**, tanpa
kehilangan validitas eksperimen.

## Isolasi kegagalan

Diuji: API Jev mati, timeout, antrean penuh, output tidak valid, dan reconnect
Gate — **perekaman pasar tetap berjalan**. Tidak ada kegagalan AI eksternal yang
menghentikan penangkapan data.

## Verifikasi adapter nyata

`bun run smoke:jev` memverifikasi (opt-in, tidak pernah di CI):

- permintaan diterima
- output terstruktur kembali dan tervalidasi
- bentuk metadata usage bila tersedia
- seluruh evaluator yang dikonfigurasi dapat di-parse

Bila `CRYPASTRA_JEV_BASE_URL` / `CRYPASTRA_JEV_API_KEY` tidak ada, smoke
**melewati dengan jujur** dan tidak mengklaim verifikasi.
