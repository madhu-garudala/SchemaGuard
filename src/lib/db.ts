import pg from "pg";

// BIGINT and NUMERIC stay strings: money never passes through a JS float.
pg.types.setTypeParser(20, (v) => v);

type G = typeof globalThis & { __sgPool?: pg.Pool };

export function pool(): pg.Pool {
  const g = globalThis as G;
  if (!g.__sgPool) g.__sgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://schema_guard:schema_guard@127.0.0.1:54329/schema_guard", max: 10 });
  return g.__sgPool;
}

export interface Db {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export async function q1<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  return (await db.query<T>(text, params)).rows[0] ?? null;
}

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const g = globalThis as G;
  if (g.__sgPool) {
    await g.__sgPool.end();
    g.__sgPool = undefined;
  }
}

export const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
