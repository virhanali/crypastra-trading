/**
 * Error domain untuk matematika exchange.
 *
 * Konvensi core: fungsi murni melempar error bertipe (bukan Result), mengikuti
 * pola Phase 0. Error ini hanya untuk input yang SECARA STRUKTURAL tidak valid.
 * Keadaan pasar yang sah tapi degenerate (mis. posisi yang langsung likuidatable)
 * dikembalikan sebagai hasil bertipe, bukan error.
 */
export class DomainError extends Error {
  override readonly name: string = "DomainError";
}

export class InvalidContractSpecError extends DomainError {
  override readonly name = "InvalidContractSpecError";
}

export class InvalidPriceError extends DomainError {
  override readonly name = "InvalidPriceError";
}

export class InvalidSizeError extends DomainError {
  override readonly name = "InvalidSizeError";
}

export class InvalidLeverageError extends DomainError {
  override readonly name = "InvalidLeverageError";
}

export class InvalidRateError extends DomainError {
  override readonly name = "InvalidRateError";
}

export class InvalidOrderError extends DomainError {
  override readonly name = "InvalidOrderError";
}

export class InvalidBookError extends DomainError {
  override readonly name = "InvalidBookError";
}
