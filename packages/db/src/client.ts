import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
// A transaction handle has the same query API as the database handle.
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Transaction;

export type DatabaseHandle = { db: Database; pool: pg.Pool; close: () => Promise<void> };

export function createDatabase(connectionString: string, options?: { max?: number }): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max: options?.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
