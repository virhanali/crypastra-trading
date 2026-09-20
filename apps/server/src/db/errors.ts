/** Error persistensi. Tidak ada Number/float yang terlibat. */

export class PersistenceError extends Error {
  override readonly name: string = "PersistenceError";
}

export class ValidationError extends PersistenceError {
  override readonly name = "ValidationError";
}

export class NotFoundError extends PersistenceError {
  override readonly name = "NotFoundError";
}

/** Pelanggaran invariant akuntansi (ledger tidak konsisten dengan cache). */
export class IntegrityError extends PersistenceError {
  override readonly name = "IntegrityError";
}

/**
 * commandId yang sama dipakai ulang dengan payload BERBEDA. Ini bukan retry
 * yang aman: klien harus menerima konflik, bukan sukses palsu (ADR 0009).
 */
export class IdempotencyConflictError extends PersistenceError {
  override readonly name = "IdempotencyConflictError";
}

/** Penarikan melebihi saldo tersedia. */
export class InsufficientFundsError extends PersistenceError {
  override readonly name = "InsufficientFundsError";
}
