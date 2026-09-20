# Design System — Modern Soft Trading Terminal

Sumber kebenaran: `apps/web/src/app.css`. Komponen **tidak boleh** menulis hex
sembarangan; semua warna/radius/elevasi berasal dari token di sini.

## Prinsip

- Terminal operasional, bukan landing page. Tidak ada tipografi marketing besar,
  tidak ada animasi dekoratif.
- Kepadatan informasi tinggi tapi terbaca: font 13px dasar, angka tabular.
- **Hijau/merah HANYA untuk makna finansial.** Elemen non-finansial (navigasi,
  tab, badge status) memakai aksen netral (`--accent`) atau warna status.
- Warna tidak pernah menjadi satu-satunya pembeda (lihat Aksesibilitas).

## Token

Semua tersedia sebagai CSS custom property; tema gelap adalah default dan tema
terang disiapkan lewat `[data-theme="light"]`.

### Permukaan
| Token | Peran |
|---|---|
| `--bg` | latar aplikasi |
| `--surface` | panel |
| `--surface-raised` | header/tab/baris sticky |
| `--surface-sunken` | input, grid chart, garis tabel |
| `--border` / `--border-strong` | pemisah / hover |

### Teks
`--text-primary`, `--text-secondary` (label), `--text-muted` (metadata).

### Semantik
`--positive`, `--negative`, `--warning`, `--info` + varian `-soft` (latar badge).
`--accent` / `--accent-soft` khusus UI (pilihan, fokus) — **bukan** sinyal PnL.

### Bentuk
`--radius-sm` 4px (kontrol), `--radius-md` 6px, `--radius-lg` 10px (kartu besar).
`--elev-1` / `--elev-2`: bayangan tertahan, tidak ada glow.

### Tipografi
`--font-sans` (Inter) untuk UI; `--font-mono` untuk angka. Kelas `.tabular`
menerapkan `font-variant-numeric: tabular-nums` sehingga kolom tidak bergeser.

## Aturan angka

- Nilai finansial selalu berasal dari API sebagai **string**.
- Kolom finansial memakai desimal **tetap** (`formatFixed`/`formatMoney`) agar
  lebar kolom stabil; harga memakai `formatPrice` (trailing zero dibuang).
- Nilai tidak tersedia → `—`, **tidak pernah** `0`.
- `Number()` hanya boleh di jalur penggambaran chart (`toNumberForChart`), yang
  didokumentasikan di ACCOUNTING.md sebagai pengecualian UI.

## Aksesibilitas

- LONG/SHORT memakai teks + glyph (`▲ LONG`, `▼ SHORT`), bukan hanya warna.
- Efek ledger memakai label arah (`▲ kas bertambah`, `▼ kas berkurang`).
- `:focus-visible` bergaris `--accent` 2px.
- Semua kontrol adalah `<button>`/`<input>` asli dan dapat diakses keyboard.
- Status penting memakai `role="status"`/`role="alert"`.

## Formulir finansial

- Input menyimpan **string mentah**; tidak ada `Number` sebagai state finansial.
- Validasi memakai decimal.js (`lib/trade/decimal.ts`), bukan aritmetika float.
- `aria-invalid` disetel saat validasi gagal dan pesan error terkait input.
- Pending state memakai `aria-busy` + `role="status"`; error memakai `role="alert"`.
- Dialog popover memakai `role="dialog"` + `tabindex="-1"` dan dapat ditutup dengan
  Escape.
- Slider leverage dan input numerik selalu tersinkron dan dibatasi rentang kontrak.

## Tema

`data-theme` pada `<html>`; toggle di TopBar. Menambah tema = menambah satu blok
token, tanpa menyentuh komponen.
