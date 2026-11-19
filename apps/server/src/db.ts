import postgres from 'postgres';
import { config } from './config.ts';

export type Sql = postgres.Sql;
/** Either the pool or an open transaction: anything a query can be run on. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export function createDb(url: string = config.databaseUrl, max = 10): Sql {
  return postgres(url, { max, onnotice: () => {} });
}

/** `now() + ms` as a SQL fragment. */
export const inMs = (q: Queryable, ms: number) => q`now() + ${ms} * interval '1 millisecond'`;
