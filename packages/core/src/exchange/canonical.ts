/**
 * Serialisasi kanonik + sidik jari determinisme (Phase 8).
 *
 * Tujuan: dua replay dengan input identik harus menghasilkan sidik jari yang
 * identik. Ini BUKAN hash kriptografis — ia sidik jari determinisme untuk
 * perbandingan, bukan alat keamanan.
 *
 * Yang DISERTAKAN: keadaan ekonomi yang bermakna (ledger, posisi, saldo, fill,
 * order).
 * Yang DIKECUALIKAN: `seq` ledger (bergantung urutan penulisan internal),
 * `idempotencyKey` (mengandung UUID akun/fill — identitas internal, bukan
 * keadaan ekonomi), UUID acak, waktu dinding pembuatan baris, dan rowid.
 * Urutan dinormalkan dengan pengurutan eksplisit atas kunci stabil, bukan
 * mengandalkan urutan iterasi basis data.
 *
 * Multiset entri tetap terdeteksi: tipe, nilai, dan referensi tiap baris ikut
 * disertakan, jadi entri hilang/berlebih mengubah sidik jari.
 */

/** Deret angka desimal; dipakai untuk membandingkan keadaan ekonomi. */
export interface CanonicalLedgerRow {
  readonly type: string;
  readonly amount: string;
  readonly marginDelta: string;
  readonly reservedDelta: string;
  readonly balanceAfter: string;
  readonly refType: string | null;
}

export interface CanonicalPositionRow {
  readonly contract: string;
  readonly direction: string;
  readonly status: string;
  readonly size: number;
  readonly entryPrice: string;
  readonly initialMargin: string;
  readonly realizedPnl: string;
  readonly accumulatedFunding: string;
  readonly feesPaid: string;
  readonly closeReason: string | null;
}

export interface CanonicalFillRow {
  readonly contract: string;
  readonly side: string;
  readonly size: number;
  readonly price: string;
  readonly fee: string;
  readonly realizedPnl: string;
  readonly liquidity: string;
  readonly isLiquidation: boolean;
  readonly isTpSl: boolean;
}

export interface CanonicalOrderRow {
  readonly contract: string;
  readonly side: string;
  readonly type: string;
  readonly size: number;
  readonly status: string;
  readonly filledSize: number;
  readonly leverage: string;
}

export interface CanonicalBalances {
  readonly walletBalance: string;
  readonly usedMargin: string;
  readonly reservedMargin: string;
  readonly realizedPnl: string;
  readonly feesPaid: string;
  readonly fundingPaid: string;
}

export interface CanonicalState {
  readonly ledger: readonly CanonicalLedgerRow[];
  readonly positions: readonly CanonicalPositionRow[];
  readonly fills: readonly CanonicalFillRow[];
  readonly orders: readonly CanonicalOrderRow[];
  readonly balances: CanonicalBalances;
}

/**
 * Serialisasi kanonik: kunci terurut, baris terurut secara total berdasarkan
 * isi (bukan urutan penyisipan), sehingga urutan iterasi DB tidak berpengaruh.
 */
export function canonicalize(state: CanonicalState): string {
  const ledger = [...state.ledger].map((row) =>
    ["L", row.type, row.amount, row.marginDelta, row.reservedDelta, row.balanceAfter, row.refType ?? "-"].join("|"),
  );
  const positions = [...state.positions].map((row) =>
    ["P", row.contract, row.direction, row.status, String(row.size), row.entryPrice, row.initialMargin, row.realizedPnl, row.accumulatedFunding, row.feesPaid, row.closeReason ?? "-"].join("|"),
  );
  const fills = [...state.fills].map((row) =>
    ["F", row.contract, row.side, String(row.size), row.price, row.fee, row.realizedPnl, row.liquidity, String(row.isLiquidation), String(row.isTpSl)].join("|"),
  );
  const orders = [...state.orders].map((row) =>
    ["O", row.contract, row.side, row.type, String(row.size), row.status, String(row.filledSize), row.leverage].join("|"),
  );
  const balances = [
    "B",
    state.balances.walletBalance,
    state.balances.usedMargin,
    state.balances.reservedMargin,
    state.balances.realizedPnl,
    state.balances.feesPaid,
    state.balances.fundingPaid,
  ].join("|");

  return [
    ...ledger.sort(),
    ...positions.sort(),
    ...fills.sort(),
    ...orders.sort(),
    balances,
  ].join("\n");
}

/**
 * Sidik jari FNV-1a 64-bit (hex). Cukup untuk deteksi perbedaan determinisme;
 * sengaja tanpa ketergantungan kripto agar inti tetap murni.
 */
export function fingerprint(canonical: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface CanonicalHashes {
  readonly ledgerHash: string;
  readonly positionsHash: string;
  readonly balancesHash: string;
  readonly fillsHash: string;
  readonly ordersHash: string;
  readonly combinedHash: string;
}

/** Sidik jari per bagian + gabungan, semuanya deterministik. */
export function canonicalHashes(state: CanonicalState): CanonicalHashes {
  const ledgerHash = fingerprint(canonicalize({ ...state, positions: [], fills: [], orders: [] }));
  const positionsHash = fingerprint(canonicalize({ ...state, ledger: [], fills: [], orders: [] }));
  const fillsHash = fingerprint(canonicalize({ ...state, ledger: [], positions: [], orders: [] }));
  const ordersHash = fingerprint(canonicalize({ ...state, ledger: [], positions: [], fills: [] }));
  const balancesHash = fingerprint(canonicalize({ ...state, ledger: [], positions: [], fills: [], orders: [] }));
  return {
    ledgerHash,
    positionsHash,
    fillsHash,
    ordersHash,
    balancesHash,
    combinedHash: fingerprint(canonicalize(state)),
  };
}
