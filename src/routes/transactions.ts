// src/routes/transactions.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, withTx } from '../db'
import { requireAuth } from '../middleware/auth'
import { distributeRevenue } from '../services/distributionEngine'

export const transactionsRouter = Router()

// ── POST /api/v1/transactions/purchase ───────────────────────

const purchaseSchema = z.object({
  version_id:     z.string().uuid(),
  payment_method: z.enum(['stripe','typ']),
  ref:            z.string().optional(),   // リファラルコード
})

transactionsRouter.post('/purchase', requireAuth, async (req: Request, res: Response) => {
  const parsed = purchaseSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { version_id, payment_method, ref } = parsed.data
  const buyerId = req.user!.id

  // バージョン取得
  const { rows: vRows } = await db.query('SELECT id, price FROM versions WHERE id=$1', [version_id])
  if (!vRows.length) return res.status(404).json({ error: 'version_not_found' })
  const version = vRows[0]

  // 重複購入チェック
  const { rows: dup } = await db.query(
    `SELECT id FROM transactions
     WHERE version_id=$1 AND buyer_id=$2 AND type='purchase' AND status='completed'`,
    [version_id, buyerId]
  )
  if (dup.length) return res.status(409).json({ error: 'already_purchased' })

  if (payment_method === 'typ') {
    // TYP払い：convertible_balance から支払い
    await withTx(async (client) => {
      const { rows: wallet } = await client.query(
        'SELECT convertible_balance FROM users WHERE id=$1 FOR UPDATE',
        [buyerId]
      )
      if (wallet[0].convertible_balance < version.price) {
        throw new Error('insufficient_balance')
      }
      // 残高から引く
      await client.query(
        'UPDATE users SET convertible_balance = convertible_balance - $1 WHERE id=$2',
        [version.price, buyerId]
      )
      // トランザクション記録
      const { rows: tx } = await client.query(
        `INSERT INTO transactions (version_id, type, amount, buyer_id, status)
         VALUES ($1,'purchase',$2,$3,'completed') RETURNING id`,
        [version_id, version.price, buyerId]
      )
      // 収益分配
      await distributeRevenue(client, tx[0].id, version_id, version.price, buyerId)
    })
  } else {
    // Stripe払い：/api/v1/stripe/checkout を使うよう案内
    return res.status(400).json({
      error: 'stripe_requires_checkout',
      message: 'Stripe決済は POST /api/v1/stripe/checkout を使用してください',
    })
  }

  res.json({ ok: true })
})

// ── POST /api/v1/transactions/tip ────────────────────────────
// TYPを贈る（投げ銭）

const tipSchema = z.object({
  version_id: z.string().uuid(),
  amount:     z.number().int().min(1).max(100000),
  message:    z.string().max(200).optional(),
})

transactionsRouter.post('/tip', requireAuth, async (req: Request, res: Response) => {
  const parsed = tipSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { version_id, amount, message } = parsed.data
  const fromId = req.user!.id

  await withTx(async (client) => {
    // sendable_balance + convertible_balance の合計チェック
    const { rows: w } = await client.query(
      'SELECT sendable_balance, convertible_balance FROM users WHERE id=$1 FOR UPDATE',
      [fromId]
    )
    const total = w[0].sendable_balance + w[0].convertible_balance
    if (total < amount) throw new Error('insufficient_balance')

    // sendable を先に消費
    const fromSendable = Math.min(w[0].sendable_balance, amount)
    const fromConv     = amount - fromSendable

    await client.query(
      `UPDATE users SET
         sendable_balance    = sendable_balance    - $1,
         convertible_balance = convertible_balance - $2
       WHERE id=$3`,
      [fromSendable, fromConv, fromId]
    )

    // バージョンの貢献者全員に TYP 分配（share_pct 比率で）
    const { rows: contributors } = await client.query(
      'SELECT user_id, role, share_pct FROM version_contributors WHERE version_id=$1',
      [version_id]
    )
    const totalContribShare = contributors.reduce((s: number, c: any) => s + Number(c.share_pct), 0)

    for (const c of contributors) {
      const toAmount = Math.floor(amount * (Number(c.share_pct) / totalContribShare))
      if (toAmount <= 0) continue

      // 受取側 convertible_balance に加算
      await client.query(
        'UPDATE users SET convertible_balance = convertible_balance + $1 WHERE id=$2',
        [toAmount, c.user_id]
      )
      // typ_transfers ログ
      await client.query(
        `INSERT INTO typ_transfers (from_id, to_id, amount, message, version_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [fromId, c.user_id, toAmount, message ?? null, version_id]
      )
      // 通知
      await client.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1,'typ_received',$2)`,
        [c.user_id, JSON.stringify({ from_user_id: fromId, amount: toAmount, version_id, message })]
      )
    }
  })

  res.json({ ok: true })
})
