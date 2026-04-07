// src/db.ts
import { Pool } from 'pg'

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
})

db.on('error', (err) => {
  console.error('[DB] unexpected error', err)
})

/** トランザクション用ヘルパー */
export async function withTx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
