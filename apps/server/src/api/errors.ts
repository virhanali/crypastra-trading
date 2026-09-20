import {
  DomainError,
  InvalidBookError,
  InvalidContractSpecError,
  InvalidLeverageError,
  InvalidOrderError,
  InvalidPriceError,
  InvalidRateError,
  InvalidSizeError,
} from "@crypastra/core";
import { z } from "zod";
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  IntegrityError,
  NotFoundError,
  ValidationError,
} from "../db/errors.js";

/**
 * Kontrak error API (docs/API.md §Errors).
 *
 * Klien menerima amplop stabil:
 *   { "error": { "code", "message", "details": {} } }
 *
 * Tidak pernah ada stack trace, pesan SQLite, atau path database yang bocor.
 */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_ORDER"
  | "INSUFFICIENT_BALANCE"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INTEGRITY_FAILURE"
  | "NOT_AVAILABLE"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const notFound = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError(404, "NOT_FOUND", message, details);

export const conflict = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError(409, "IDEMPOTENCY_CONFLICT", message, details);

export const notAvailable = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError(503, "NOT_AVAILABLE", message, details);

export const validationFailed = (
  message: string,
  details: Record<string, unknown> = {},
): ApiError => new ApiError(400, "VALIDATION_ERROR", message, details);

/**
 * Petakan error apa pun ke ApiError.
 *
 * Pemetaan status:
 *   ZodError / ValidationError / Invalid*  → 400 VALIDATION_ERROR
 *   InvalidOrderError                      → 422 INVALID_ORDER
 *   InsufficientFundsError                 → 422 INSUFFICIENT_BALANCE
 *   NotFoundError                          → 404 NOT_FOUND
 *   IdempotencyConflictError               → 409 IDEMPOTENCY_CONFLICT
 *   IntegrityError                         → 503 INTEGRITY_FAILURE
 *   lainnya                                → 500 INTERNAL_ERROR (pesan digeneralisasi)
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof z.ZodError) {
    return validationFailed("Permintaan tidak valid", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  if (error instanceof InvalidOrderError) {
    return new ApiError(422, "INVALID_ORDER", error.message);
  }
  if (error instanceof InsufficientFundsError) {
    return new ApiError(422, "INSUFFICIENT_BALANCE", error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return new ApiError(409, "IDEMPOTENCY_CONFLICT", error.message);
  }
  if (error instanceof NotFoundError) {
    return new ApiError(404, "NOT_FOUND", error.message);
  }
  if (error instanceof IntegrityError) {
    return new ApiError(503, "INTEGRITY_FAILURE", error.message);
  }

  if (error instanceof ValidationError) {
    return validationFailed(error.message);
  }
  if (
    error instanceof InvalidPriceError ||
    error instanceof InvalidSizeError ||
    error instanceof InvalidLeverageError ||
    error instanceof InvalidRateError ||
    error instanceof InvalidContractSpecError ||
    error instanceof InvalidBookError
  ) {
    return validationFailed(error.message);
  }
  if (error instanceof DomainError) {
    return validationFailed(error.message);
  }

  // Jangan bocorkan detail internal (SQL, path, stack).
  return new ApiError(500, "INTERNAL_ERROR", "Terjadi kesalahan internal");
}
