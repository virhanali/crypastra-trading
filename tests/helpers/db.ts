import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  type DatabaseConnection,
  type DatabaseOptions,
} from "../../apps/server/src/db/database.js";

export interface TempDatabase {
  readonly path: string;
  readonly connection: DatabaseConnection;
  cleanup(): void;
}

let counter = 0;

export function tempDatabasePath(): string {
  counter += 1;
  const dir = mkdtempSync(join(tmpdir(), `crypastra-test-${counter}-`));
  return join(dir, "test.db");
}

export function openTempDatabase(options: Omit<DatabaseOptions, "path"> = {}): TempDatabase {
  const path = tempDatabasePath();
  const connection = openDatabase({ ...options, path });
  return {
    path,
    connection,
    cleanup() {
      try {
        connection.close();
      } catch {
        // sudah tertutup
      }
      rmSync(join(path, ".."), { recursive: true, force: true });
    },
  };
}

export function cleanupPath(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}
