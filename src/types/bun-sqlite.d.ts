/**
 * Ambient type declaration for bun:sqlite.
 *
 * The project has no Bun types installed (tsconfig "types": ["node"]), but the
 * Bun runtime backend (see services/db.ts) loads `bun:sqlite` at runtime via
 * dynamic import. This ambient module lets tsc type-check that branch without
 * shipping Bun types to Node consumers.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    exec(sql: string): void;
    close(): void;
    query<T extends unknown[] = unknown[], R = unknown>(sql: string): {
      get(...params: T): R | null;
      all(...params: T): R[];
      run(...params: T): { changes: number; lastInsertRowid: number };
    };
  }
}
