// src/routes/stripe.ts
import { Router, Request, Response } from 'express'
import Stripe from 'stripe'
import { db, withTx } from '../db'
import { requireAuth } from '../middleware/auth'
import { distributeRevenue } from '../services/distributionEngine'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-04-10',
})

export const stripeRouter = Router()

// ── POST /api/v1/stripe/checkout ─────────────────────────────
// Stripe Checkout Session を作成してURLを返す

stripeRouter.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  const { version_id } = req.body
  if (!version_id) return res.status(400).json({ error: 'version_id is required' })

  const buyerId = req.user!.id

  // バージョン取得
  const { rows: vRows } = await db.query(
    `SELECT v.id, v.price, v.title
     FROM versions v WHERE v.id=$1`,
    [version_id]
  )
  if (!vRows.length) return res.status(404).json({ error: 'version_not_found' })
  const version = vRows[0]

  // 重複購入チェック
  const { rows: dup } = await db.query(
    `SELECT id FROM transactions
     WHERE version_id=$1 AND buyer_id=$2 AND type='purchase' AND status='completed'`,
    [version_id, buyerId]
  )
  if (dup.length) return res.status(409).json({ error: 'already_purchased' })

  // Checkout Session 作成
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'jpy',
          product_data: { name: version.title ?? 'ウタタネ楽曲' },
          unit_amount: version.price,
        },
        quantity: 1,
      },
    ],
    metadata: {
      version_id,
      buyer_id: buyerId,
    },
    success_url: `${process.env.CLIENT_URL}/versions/${version_id}?payment=success`,
    cancel_url: `${process.env.CLIENT_URL}/versions/${version_id}?payment=cancel`,
  })

  // pending トランザクションを作成
  await db.query(
    `INSERT INTO transactions (version_id, type, amount, buyer_id, status, stripe_session_id)
     VALUES ($1,'purchase',$2,$3,'pending',$4)`,
    [version_id, version.price, buyerId, session.id]
  )

  res.json({ url: session.url })
})

// ── POST /api/v1/stripe/webhook ──────────────────────────────
// Stripe Webhook 受信・署名検証・決済完了処理

stripeRouter.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string
  if (!sig) return res.status(400).json({ error: 'missing stripe-signature header' })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      req.body,       // raw body (Buffer)
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('[Stripe Webhook] signature verification failed:', err.message)
    return res.status(400).json({ error: 'webhook_signature_invalid' })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const { version_id, buyer_id } = session.metadata ?? {}

    if (!version_id || !buyer_id) {
      console.error('[Stripe Webhook] missing metadata', session.id)
      return res.status(400).json({ error: 'missing_metadata' })
    }

    // pending → completed に更新 & 収益分配
    await withTx(async (client) => {
      // 既に完了済みなら何もしない（冪等性）
      const { rows: txRows } = await client.query(
        `SELECT id, status FROM transactions
         WHERE stripe_session_id=$1 FOR UPDATE`,
        [session.id]
      )
      if (!txRows.length) {
        console.error('[Stripe Webhook] transaction not found for session:', session.id)
        return
      }
      if (txRows[0].status === 'completed') return // 冪等

      const tx = txRows[0]

      await client.query(
        `UPDATE transactions SET status='completed' WHERE id=$1`,
        [tx.id]
      )

      // バージョンの価格を取得
      const { rows: vRows } = await client.query(
        'SELECT price FROM versions WHERE id=$1',
        [version_id]
      )
      const price = vRows[0]?.price ?? 0

      await distributeRevenue(client, tx.id, version_id, price, buyer_id)
    })
  }

  res.json({ received: true })
})
