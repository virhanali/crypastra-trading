/**
 * Idempotensi perintah di sisi klien.
 *
 * Aturan (docs/API.md): setiap operasi tulis membawa `commandId`. Retry untuk
 * AKSI YANG SAMA harus memakai id yang SAMA, supaya backend mengenalinya sebagai
 * retry, bukan perintah baru. Id baru hanya dibuat untuk aksi baru.
 *
 * `CommandBook` menyimpan id per kunci aksi sampai aksi itu dinyatakan selesai.
 */
export class CommandBook {
  readonly #byKey = new Map<string, string>();
  readonly #newId: () => string;

  constructor(newId: () => string) {
    this.#newId = newId;
  }

  /** Id stabil untuk sebuah aksi; dibuat sekali, dipakai ulang saat retry. */
  for(actionKey: string): string {
    const existing = this.#byKey.get(actionKey);
    if (existing !== undefined) {
      return existing;
    }
    const created = this.#newId();
    this.#byKey.set(actionKey, created);
    return created;
  }

  /** Panggil setelah hasil FINAL diterima (sukses definitif). */
  settle(actionKey: string): void {
    this.#byKey.delete(actionKey);
  }

  /** Jumlah aksi yang masih menggantung (untuk test/diagnostik). */
  pending(): number {
    return this.#byKey.size;
  }
}

/**
 * Kunci aksi: identitas SEMANTIK dari aksi pengguna, bukan waktu.
 * Retry aksi yang sama → kunci sama → commandId sama.
 */
export function actionKey(operation: string, params: Record<string, string | number>): string {
  const parts = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`);
  return `${operation}|${parts.join("|")}`;
}

let fallbackCounter = 0;

/** Id unik default. `crypto.randomUUID` bila tersedia. */
export function defaultCommandId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID !== undefined) {
    return cryptoRef.randomUUID();
  }
  fallbackCounter += 1;
  return `cmd-${Date.now().toString(36)}-${fallbackCounter}`;
}
