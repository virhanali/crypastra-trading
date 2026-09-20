import { randomUUID } from "node:crypto";

/** ID domain: TEXT UUID v4. Ledger memakai `seq` autoincrement, bukan UUID. */
export function newId(): string {
  return randomUUID();
}
