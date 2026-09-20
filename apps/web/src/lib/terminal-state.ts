/**
 * State terminal yang dapat dialamatkan lewat URL.
 *
 * HANYA pilihan kontrak yang masuk URL. State akuntansi (saldo, posisi)
 * TIDAK pernah ditaruh di URL.
 */

export const DEFAULT_CONTRACT = "BTC_USDT";

export interface RouteState {
  readonly contract: string;
}

export function routeFromPath(pathname: string, fallback = DEFAULT_CONTRACT): RouteState {
  const match = /^\/trade\/([A-Za-z0-9_]+)\/?$/.exec(pathname);
  if (match === null) {
    const bare = /^\/([A-Za-z0-9]+_[A-Za-z0-9]+)\/?$/.exec(pathname);
    return { contract: bare?.[1] ?? fallback };
  }
  return { contract: match[1] ?? fallback };
}

export function pathForContract(contract: string): string {
  return `/trade/${encodeURIComponent(contract)}`;
}

/** Filter watchlist sederhana: cocokkan seluruh atau sebagian simbol. */
export function filterContracts<T extends { contract: string }>(contracts: readonly T[], query: string): T[] {
  const needle = query.trim().toUpperCase();
  if (needle === "") {
    return [...contracts];
  }
  return contracts.filter((entry) => entry.contract.toUpperCase().includes(needle));
}
