// src/routes/auth.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import { SignJWT, jwtVerify } from 'jose'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db'
import { blacklistJti, isBlacklisted } from '../redis'
import { requireAuth } from '../middleware/auth'

export const authRouter = Router()

const secret  = new TextEncoder().encode(process.env.JWT_SECRET!)
const rSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET!)

// ── トークン生成 ──────────────────────────────────────────────

async function signAccess(userId: string, roles: string[]) {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(uuidv4())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)
}

async function signRefresh(userId: string) {
  const jti = uuidv4()
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(rSecret)

  // DBに保存
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(
    'INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)',
    [jti, userId, expiresAt]
  )
  return token
}

// ── POST /api/v1/auth/register ────────────────────────────────

const registerSchema = z.object({
  name:     z.string().min(1).max(50),
  email:    z.string().email(),
  password: z.string().min(8).max(100),
})

authRouter.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { name, email, password } = parsed.data

  // メール重複チェック
  const exists = await db.query('SELECT id FROM users WHERE email=$1', [email])
  if (exists.rowCount! > 0) return res.status(409).json({ error: 'email_taken' })

  const password_hash = await bcrypt.hash(password, 12)
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1,$2,$3) RETURNING id, name, email, roles`,
    [name, email, password_hash]
  )
  const user = rows[0]

  const [access, refresh] = await Promise.all([
    signAccess(user.id, user.roles),
    signRefresh(user.id),
  ])

  res.status(201).json({ access_token: access, refresh_token: refresh, user })
})

// ── POST /api/v1/auth/login ───────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
})

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { email, password } = parsed.data
  const { rows } = await db.query(
    'SELECT id, name, email, roles, password_hash FROM users WHERE email=$1',
    [email]
  )
  const user = rows[0]
  if (!user) return res.status(401).json({ error: 'invalid_credentials' })

  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' })

  const [access, refresh] = await Promise.all([
    signAccess(user.id, user.roles),
    signRefresh(user.id),
  ])

  const { password_hash: _, ...safeUser } = user
  res.json({ access_token: access, refresh_token: refresh, user: safeUser })
})

// ── POST /api/v1/auth/refresh ─────────────────────────────────

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const token = req.body.refresh_token as string
  if (!token) return res.status(400).json({ error: 'missing_token' })

  try {
    const { payload } = await jwtVerify(token, rSecret)
    const jti    = payload.jti as string
    const userId = payload.sub as string

    // DBでjtiを確認
    const { rows } = await db.query(
      'SELECT jti FROM refresh_tokens WHERE jti=$1 AND user_id=$2 AND expires_at > now()',
      [jti, userId]
    )
    if (!rows.length) return res.status(401).json({ error: 'invalid_refresh_token' })

    // Blacklistも確認
    if (await isBlacklisted(jti)) return res.status(401).json({ error: 'token_revoked' })

    const { rows: userRows } = await db.query(
      'SELECT id, roles FROM users WHERE id=$1',
      [userId]
    )
    const user = userRows[0]

    const access = await signAccess(user.id, user.roles)
    res.json({ access_token: access })
  } catch {
    res.status(401).json({ error: 'invalid_refresh_token' })
  }
})

// ── POST /api/v1/auth/logout ──────────────────────────────────

authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? ''
  try {
    const { payload } = await jwtVerify(token, secret)
    const jti = payload.jti as string
    const exp = (payload.exp ?? 0) - Math.floor(Date.now() / 1000)
    if (exp > 0) await blacklistJti(jti, exp)
  } catch {}

  // リフレッシュトークンも全削除
  if (req.user?.id) {
    await db.query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.user.id])
  }
  res.json({ ok: true })
})
