// src/redis.ts
import { createClient } from 'redis'

export const redis = createClient({ url: process.env.REDIS_URL })

redis.on('error', (err) => console.error('[Redis]', err))

export async function connectRedis() {
  await redis.connect()
  console.log('[Redis] connected')
}

/** JTIをブラックリストに追加（ログアウト用） */
export async function blacklistJti(jti: string, ttlSeconds: number) {
  await redis.setEx(`bl:${jti}`, ttlSeconds, '1')
}

/** JTIがブラックリストにあるか確認 */
export async function isBlacklisted(jti: string): Promise<boolean> {
  return (await redis.get(`bl:${jti}`)) === '1'
}

/** キャッシュ汎用 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const v = await redis.get(key)
  return v ? JSON.parse(v) : null
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 60) {
  await redis.setEx(key, ttlSeconds, JSON.stringify(value))
}

export async function cacheDel(...keys: string[]) {
  if (keys.length) await redis.del(keys)
}
