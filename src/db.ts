/**
 * One tiny query interface over either a real Postgres (DATABASE_URL) or an
 * embedded PGlite database. Same SQL either way, so what you test locally is
 * what runs in production.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Multi-statement SQL (migrations). Parameters are not supported here. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL?.trim();

  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    singleton = {
      kind: "postgres",
      query: (sql, params) => pool.query(sql, params as any[]) as any,
      exec: async (sql) => { await pool.query(sql); },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = process.env.PGLITE_DIR ?? "./.pgdata";
    const lite = await PGlite.create(dir);
    singleton = {
      kind: "pglite",
      query: (sql, params) => lite.query(sql, params as any[]) as any,
      exec: async (sql) => { await lite.exec(sql); },
      close: () => lite.close(),
    };
  }
  return singleton;
}

/** Test helper: a throwaway in-memory database with the schema applied. */
export async function memoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create();
  const db: Db = {
    kind: "pglite",
    query: (sql, params) => lite.query(sql, params as any[]) as any,
    exec: async (sql) => { await lite.exec(sql); },
    close: () => lite.close(),
  };
  const { readFileSync } = await import("node:fs");
  await db.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  return db;
}

export function resetDbSingleton() { singleton = null; }
