// src/routes/wallet.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, withTx } from '../db'
import { requireAuth } from '../middleware/auth'

export const walletRouter = Router()

// ── GET /api/v1/wallet ────────────────────────────────────────

walletRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await db.query(
    'SELECT convertible_balance, sendable_balance FROM users WHERE id=$1',
    [req.user!.id]
  )
  res.json(rows[0])
})

// ── GET /api/v1/wallet/history ────────────────────────────────

walletRouter.get('/history', requireAuth, async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit ?? 30), 100)
  const offset = Number(req.query.offset ?? 0)

  // TYP受取 + 送付 + 換金を統合して時系列で返す
  const { rows } = await db.query(
    `(
       SELECT 'received' AS direction, amount, created_at,
              from_id AS counterpart_id, version_id, message
       FROM typ_transfers WHERE to_id=$1
     ) UNION ALL (
       SELECT 'sent' AS direction, -amount AS amount, created_at,
              to_id AS counterpart_id, version_id, message
       FROM typ_transfers WHERE from_id=$1
     ) UNION ALL (
       SELECT 'redeemed' AS direction, -amount AS amount, created_at,
              NULL AS counterpart_id, NULL AS version_id, NULL AS message
       FROM typ_redemptions WHERE user_id=$1
     )
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user!.id, limit, offset]
  )
  res.json({ history: rows, limit, offset })
})

// ── POST /api/v1/wallet/send — TYP送付 ───────────────────────

const sendSchema = z.object({
  to_user_id: z.string().uuid(),
  amount:     z.number().int().min(1),
  message:    z.string().max(200).optional(),
})

walletRouter.post('/send', requireAuth, async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { to_user_id, amount, message } = parsed.data
  const fromId = req.user!.id
  if (to_user_id === fromId) return res.status(400).json({ error: 'cannot_send_to_self' })

  await withTx(async (client) => {
    const { rows: w } = await client.query(
      'SELECT sendable_balance FROM users WHERE id=$1 FOR UPDATE',
      [fromId]
    )
    if (w[0].sendable_balance < amount) throw new Error('insufficient_sendable_balance')

    await client.query(
      'UPDATE users SET sendable_balance = sendable_balance - $1 WHERE id=$2',
      [amount, fromId]
    )
    await client.query(
      'UPDATE users SET convertible_balance = convertible_balance + $1 WHERE id=$2',
      [amount, to_user_id]
    )
    await client.query(
      `INSERT INTO typ_transfers (from_id, to_id, amount, message)
       VALUES ($1,$2,$3,$4)`,
      [fromId, to_user_id, amount, message ?? null]
    )
    await client.query(
      `INSERT INTO notifications (user_id, type, payload) VALUES ($1,'typ_received',$2)`,
      [to_user_id, JSON.stringify({ from_user_id: fromId, amount, message })]
    )
  })

  res.json({ ok: true })
})

// ── POST /api/v1/wallet/redeem — 換金申請 ────────────────────

const redeemSchema = z.object({
  amount:    z.number().int().min(1000),    // 最低 1,000 TYP から
  bank_info: z.object({
    bank_name:      z.string(),
    branch_name:    z.string(),
    account_type:   z.enum(['ordinary','current']),
    account_number: z.string(),
    account_name:   z.string(),
  }),
})

walletRouter.post('/redeem', requireAuth, async (req: Request, res: Response) => {
  const parsed = redeemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { amount, bank_info } = parsed.data
  const FEE_RATE  = 0.05
  const feeAmount = Math.floor(amount * FEE_RATE)
  const netAmount = amount - feeAmount

  // 翌月15日を計算
  const now = new Date()
  const scheduledAt = new Date(now.getFullYear(), now.getMonth() + 1, 15)

  await withTx(async (client) => {
    const { rows: w } = await client.query(
      'SELECT convertible_balance FROM users WHERE id=$1 FOR UPDATE',
      [req.user!.id]
    )
    if (w[0].convertible_balance < amount) throw new Error('insufficient_balance')

    await client.query(
      'UPDATE users SET convertible_balance = convertible_balance - $1 WHERE id=$2',
      [amount, req.user!.id]
    )
    await client.query(
      `INSERT INTO typ_redemptions (user_id, amount, fee_amount, net_amount, bank_info, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user!.id, amount, feeAmount, netAmount, JSON.stringify(bank_info), scheduledAt]
    )
  })

  res.json({ ok: true, fee_amount: feeAmount, net_amount: netAmount, scheduled_at: scheduledAt })
})

// ── POST /api/v1/wallet/donate — 寄付 ────────────────────────

const donateSchema = z.object({
  amount: z.number().int().min(1),
  cause:  z.string().max(100).optional(),   // 寄付先メモ
})

walletRouter.post('/donate', requireAuth, async (req: Request, res: Response) => {
  const parsed = donateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { amount } = parsed.data

  await withTx(async (client) => {
    const { rows: w } = await client.query(
      'SELECT convertible_balance FROM users WHERE id=$1 FOR UPDATE',
      [req.user!.id]
    )
    if (w[0].convertible_balance < amount) throw new Error('insufficient_balance')

    await client.query(
      'UPDATE users SET convertible_balance = convertible_balance - $1 WHERE id=$2',
      [amount, req.user!.id]
    )
    // 寄付はPFが現金化して届ける（将来: 寄付先テーブルで管理）
    // ここでは残高を減らすのみ
  })

  res.json({ ok: true })
})
