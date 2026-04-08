// src/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { connectRedis } from './redis'
import { db } from './db'
import { authRouter         } from './routes/auth'
import { usersRouter        } from './routes/users'
import { worksRouter        } from './routes/works'
import { versionsRouter     } from './routes/versions'
import { transactionsRouter } from './routes/transactions'
import { walletRouter       } from './routes/wallet'
import { notificationsRouter} from './routes/notifications'
import { stripeRouter       } from './routes/stripe'

const app  = express()
const PORT = process.env.PORT ?? 3001

// ── ミドルウェア ──────────────────────────────────────────────

app.use(helmet())
app.use(cors({
  origin: [process.env.CLIENT_URL!, 'https://utatane-fe.vercel.app', 'https://utatane.music', 'https://www.utatane.music'],
  credentials: true,
}))

// Stripe Webhook は raw body が必要なので express.json() の前に登録
app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }))

app.use(express.json())
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }))

// ── ルート ────────────────────────────────────────────────────

app.use('/api/v1/auth',          authRouter)
app.use('/api/v1/users',         usersRouter)
app.use('/api/v1/works',         worksRouter)
app.use('/api/v1/versions',      versionsRouter)
app.use('/api/v1/transactions',  transactionsRouter)
app.use('/api/v1/wallet',        walletRouter)
app.use('/api/v1/notifications', notificationsRouter)
app.use('/api/v1/stripe',        stripeRouter)

// ── ヘルスチェック ────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1')
    res.json({ ok: true, db: 'ok' })
  } catch {
    res.status(500).json({ ok: false, db: 'error' })
  }
})

// ── エラーハンドラー ─────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err.message
  if (msg === 'insufficient_balance' || msg === 'insufficient_sendable_balance') {
    return res.status(400).json({ error: msg })
  }
  console.error('[ERROR]', err)
  res.status(500).json({ error: 'internal_server_error' })
})

// ── 起動 ──────────────────────────────────────────────────────

async function main() {
  await connectRedis()
  app.listen(PORT, () => {
    console.log(`🌱 ウタタネ API running on http://localhost:${PORT}`)
  })
}

main().catch(console.error)
