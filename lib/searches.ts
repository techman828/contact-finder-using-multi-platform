import { db } from './db';
import type { Search } from './types';

const SEARCH_COLS = 'id, linkedin_url, status, full_name, headline, emails, phones, created_at, finished_at';

export async function getSearch(id: number): Promise<Search | null> {
  const sql = await db();
  const [s] = await sql`SELECT ${sql.unsafe(SEARCH_COLS)} FROM searches WHERE id = ${id}`;
  if (!s) return null;
  const providers = await sql`
    SELECT provider, position, status, message, emails, phones, person, credits_left, duration_ms, api_key_label
    FROM provider_results WHERE search_id = ${id} ORDER BY position`;
  return { ...(s as unknown as Search), providers: providers as any };
}

export async function listSearches({ q = '', limit = 50, offset = 0 } = {}) {
  const sql = await db();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = q
    ? sql`WHERE linkedin_url ILIKE ${like} OR full_name ILIKE ${like} OR emails::text ILIKE ${like} OR phones::text ILIKE ${like}`
    : sql``;
  const [rows, [{ total }]] = await Promise.all([
    sql`SELECT ${sql.unsafe(SEARCH_COLS)} FROM searches ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT count(*)::int AS total FROM searches ${where}`,
  ]);
  return { rows: rows as unknown as Search[], total: total as number };
}

export async function getProviderRaw(searchId: number, provider: string) {
  const sql = await db();
  const [row] = await sql`SELECT raw FROM provider_results WHERE search_id = ${searchId} AND provider = ${provider}`;
  return row?.raw ?? null;
}

export async function deleteSearch(id: number) {
  const sql = await db();
  await sql`DELETE FROM searches WHERE id = ${id}`;
}

export async function clearSearches() {
  const sql = await db();
  await sql`DELETE FROM searches`;
}

/** Stream-friendly batches for CSV export. */
export async function* allSearches(batch = 500) {
  const sql = await db();
  for (let lastId = 2 ** 31 - 1; ; ) {
    const rows = await sql`
      SELECT ${sql.unsafe(SEARCH_COLS)} FROM searches WHERE id < ${lastId} ORDER BY id DESC LIMIT ${batch}`;
    if (!rows.length) return;
    yield rows as unknown as Search[];
    lastId = rows[rows.length - 1].id;
  }
}
