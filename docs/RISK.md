# Risk Engine & kebijakan `risk-v1`

Implementasi: `packages/core/src/decision/engine.ts` (bagian risiko),
`packages/core/src/decision/risk-policy.ts`, `packages/core/src/decision/tick-policy.ts`.

**PAPER BASELINE.** Default di bawah dipilih konservatif. Ini **bukan** hasil
optimasi, **bukan** klaim profitabilitas, dan **tidak** disetel terhadap hasil
replay (tidak ada pencarian parameter).

## Default `risk-v1`

| Kunci | Default | Alasan |
|---|---|---|
| `riskPerTradePct` | `"1"` | Risiko per transaksi 1% equity — kerugian bila SL kena |
| `maxPositionNotionalPct` | `"300"` | Notional ≤ 3× equity; menahan sizing saat SL sangat rapat |
| `maxTotalMarginPct` | `"50"` | Total margin ≤ 50% equity |
| `maxOpenPositions` | `5` | Batas posisi lintas kontrak |
| `maxPositionsPerContract` | `1` | Satu posisi per kontrak di V1 |
| `defaultLeverage` | `"10"` | Leverage default, deterministik |
| `maxLeverage` | `"20"` | Batas tegas di samping batas kontrak |
| `atrStopMultiplier` | `"2"` | Jarak stop awal = 2× ATR14 |
| `rewardRiskRatio` | `"2"` | Target TP = 2× jarak stop |
| `minimumRewardRiskRatio` | `"1.5"` | RR minimum SETELAH pembulatan tick |
| `minimumStopDistancePct` | `"0.2"` | ATR bisa menghasilkan stop patologis |
| `maximumStopDistancePct` | `"5"` | Batas atas jarak stop |

`riskPolicyHash` = hash urutan-kunci-independen atas seluruh kebijakan, dipersist
di setiap keputusan bersama `riskPolicyVersion = "risk-v1"`.

## Sizing: risiko dulu, bukan `wallet × leverage`

```
riskBudget      = equity × riskPerTradePct / 100
stopDistance    = |referencePrice − stopLoss|        (dari harga SL HASIL tick)
riskPerContract = quantoMultiplier × stopDistance
rawSize         = riskBudget / riskPerContract
```

Lalu dinormalisasi (bagian berikut) dan **hanya boleh turun**, tidak pernah naik.

Leverage **bukan** risiko: menaikkan leverage tidak menaikkan risiko per
transaksi pada jarak stop yang sama; ia hanya menurunkan margin. Karena itu
sizing tidak pernah memakai `wallet × leverage`.

## Stop dari ATR

```
LONG :  SL_teoretis = referencePrice − ATR14 × atrStopMultiplier
SHORT:  SL_teoretis = referencePrice + ATR14 × atrStopMultiplier
```

- ATR tidak tersedia atau ≤ 0 → `ATR_UNAVAILABLE`, skip.
- `stopDistancePct` di luar `[minimumStopDistancePct, maximumStopDistancePct]` →
  `STOP_DISTANCE_TOO_TIGHT` / `STOP_DISTANCE_TOO_WIDE`, skip.
- Model stop **tidak** diganti diam-diam dengan persentase arbitrer bila ATR ada.

## Pembulatan harga protektif (arah-sadar)

Pembulatan tick TIDAK netral. Aturannya dipilih supaya rencana tidak pernah
melebihi risiko terencana dan tidak pernah membesar-besarkan reward:

| Harga | LONG | SHORT |
|---|---|---|
| Stop loss | ROUND_CEIL (mendekati entry) | ROUND_FLOOR (mendekati entry) |
| Take profit | ROUND_FLOOR (mendekati entry) | ROUND_CEIL (mendekati entry) |

Konsekuensi: `stopDistance` aktual ≤ jarak terencana, dan reward aktual ≤ reward
terencana. **Sizing memakai jarak stop hasil pembulatan**, bukan nilai teoretis.

Tick diambil dari `orderPriceRound` kontrak (sampai 11 dp, mis. SATS_USDT).

## Take profit & RR

```
rewardDistance = stopDistance × rewardRiskRatio
LONG :  TP_teoretis = referencePrice + rewardDistance
SHORT:  TP_teoretis = referencePrice − rewardDistance
```

TP dinormalisasi ke tick, lalu RR aktual dihitung ulang:

```
RR_aktual = |TP_hasil_tick − referencePrice| / stopDistance
```

Bila `RR_aktual < minimumRewardRiskRatio` → `REWARD_RISK_TOO_LOW`, **skip**.
Pembulatan tick yang merusak RR minimum tidak boleh diloloskan.

## Normalisasi ukuran

- Kontrak `enable_decimal = false` → `ROUND_FLOOR` ke integer.
- Kontrak `enable_decimal = true` → `ROUND_FLOOR` ke 8 dp (skala akuntansi;
  `ContractSpec` tidak mengekspos langkah ukuran).
- Ukuran **selalu dibulatkan ke bawah** — risiko tidak pernah dinaikkan untuk
  memenuhi minimum.
- `size < orderSizeMin` (atau ≤ 0) → `SIZE_BELOW_MINIMUM`, skip.
- `size > orderSizeMax` → dijepit ke `orderSizeMax` + `SIZE_CAPPED_CONTRACT_MAX`.

## Cap notional

```
maxNotional = equity × maxPositionNotionalPct / 100
```

Bila `notional > maxNotional`: ukuran diturunkan ke `maxNotional / (multiplier × harga)`
(dibulatkan ke bawah sesuai aturan kontrak) + `SIZE_CAPPED_NOTIONAL`. Setelah
cap, **notional, margin, risk, dan reward dihitung ulang** dari ukuran final.
Ukuran tidak pernah dinaikkan untuk mencapai target.

## Leverage

```
lower  = max(spec.leverageMin, 1)
upper  = min(spec.leverageMax, policy.maxLeverage)
chosen = clamp(policy.defaultLeverage, lower, upper)
```

Bila `lower > upper` → `LEVERAGE_UNAVAILABLE`, skip. Leverage **tidak** diturunkan
dari keyakinan sinyal, dan nantinya tidak akan diturunkan dari keyakinan Jev.

## Margin

```
initialMargin = ceil8(notional / leverage)        (initialMarginFor)
```

Dua batas ditegakkan, dan keduanya harus lolos:

1. `initialMargin <= availableBalance` → kalau tidak, `INSUFFICIENT_AVAILABLE_BALANCE`.
2. `positionMargin + reservedMargin + initialMargin <= equity × maxTotalMarginPct/100`
   → kalau tidak, `TOTAL_MARGIN_LIMIT`.

Memeriksa `availableBalance` saja tidak cukup: margin bisa muat secara saldo
tetapi melanggar batas total margin kebijakan.

## Batas posisi

- Posisi yang sudah ada di kontrak yang sama → `EXISTING_CONTRACT_POSITION`, skip.
- Jumlah posisi pada kontrak ≥ `maxPositionsPerContract` → `CONTRACT_POSITION_LIMIT`.
- Jumlah posisi terbuka ≥ `maxOpenPositions` → `MAX_OPEN_POSITIONS`.

Baseline V1 **tidak** menambah, mengurangi, atau membalik posisi secara otomatis.
Semantik manual Paper Exchange tidak berubah.

## Invarian rencana yang disetujui

Untuk setiap TradePlan dengan `action = "trade"`:

- `size > 0`
- `riskAmount <= equity × riskPerTradePct/100`
- `initialMargin <= availableBalance`
- `leverage <= min(policy.maxLeverage, spec.leverageMax)`
- `notional <= equity × maxPositionNotionalPct/100`
- SL di sisi benar (LONG: SL < entry; SHORT: SL > entry)
- TP di sisi benar (LONG: TP > entry; SHORT: TP < entry)
- `rewardRiskRatio >= minimumRewardRiskRatio`

Semuanya diuji di `tests/phase10-decision.test.ts`.

## Rencana vs risiko aktual (Phase 11)

`TradePlan.referencePrice` adalah konteks perencanaan. Isian PAPER memakai
kutipan saat itu, jadi isian bisa berbeda dari acuan. Risiko awal aktual:

```
actualInitialRisk = |actualEntry − stopLoss| × quantoMultiplier × size terisi
```

Ukuran **tidak** diubah setelah isian dan SL **tidak** digeser untuk memulihkan
risiko terencana. Drift hanya diukur (`plannedRiskAmount` vs
`actualInitialRiskAmount`) dan dilaporkan per trade.

## Normalisasi ukuran dan kontrak desimal (Phase 11.5)

Phase 10 sudah menormalkan ukuran sesuai kontrak saat PERENCANAAN
(`ROUND_FLOOR` ke integer untuk `enable_decimal=false`, ke 8 dp untuk
`enable_decimal=true`). Phase 11.5 memastikan ukuran hasil perencanaan itu
benar-benar dapat DIEKSEKUSI: batas eksekusi kini sadar kontrak, sehingga
`TradePlan` berukuran pecahan pada kontrak `enable_decimal=true` tidak lagi
ditolak sebagai `SIZE_NOT_EXECUTABLE`.

Kebijakan risiko `risk-v1` tidak berubah: `riskPerTradePct`, `atrStopMultiplier`,
`rewardRiskRatio`, `defaultLeverage`, dan seluruh cap tetap sama. Yang berubah
hanya kemampuan mengeksekusi ukuran yang sudah diizinkan kontrak.
