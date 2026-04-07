// src/routes/versions.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'

export const versionsRouter = Router()

// ── POST /api/v1/versions — バージョン作成 ───────────────────

const createSchema = z.object({
  melody_work_id: z.string().uuid(),
  lyrics_work_id: z.string().uuid(),
  title:          z.string().min(1).max(100),
  audio_url:      z.string().url().optional(),
  video_external_url: z.string().url().optional(),
  lyrics_text:    z.string().optional(),
  price:          z.number().int().min(100).max(50000).default(300),
  // 貢献者（自分以外も指定可能）
  contributors: z.array(z.object({
    user_id:   z.string().uuid(),
    role:      z.enum(['composer','lyricist','musician']),
    share_pct: z.number().min(0.01).max(1),
  })).min(1),
})

versionsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const d = parsed.data

  // シェア合計チェック（PF分25% + viewer分5% = 30% 残りが貢献者分）
  const totalShare = d.contributors.reduce((s, c) => s + c.share_pct, 0)
  if (Math.abs(totalShare - 0.7) > 0.001) {
    return res.status(400).json({ error: 'contributors_share_must_be_0.7' })
  }

  // works の reuse_mode 確認
  const { rows: mWork } = await db.query('SELECT reuse_mode FROM works WHERE id=$1', [d.melody_work_id])
  const { rows: lWork } = await db.query('SELECT reuse_mode FROM works WHERE id=$1', [d.lyrics_work_id])
  if (!mWork.length || !lWork.length) return res.status(404).json({ error: 'work_not_found' })
  if (mWork[0].reuse_mode === 'exclusive' || lWork[0].reuse_mode === 'exclusive') {
    return res.status(403).json({ error: 'work_is_exclusive' })
  }

  // バージョン登録
  const { rows } = await db.query(
    `INSERT INTO versions
       (melody_work_id, lyrics_work_id, title, audio_url, video_external_url, lyrics_text, price)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [d.melody_work_id, d.lyrics_work_id, d.title,
     d.audio_url ?? null, d.video_external_url ?? null, d.lyrics_text ?? null, d.price]
  )
  const version = rows[0]

  // 貢献者登録
  for (const c of d.contributors) {
    await db.query(
      `INSERT INTO version_contributors (version_id, user_id, role, share_pct)
       VALUES ($1,$2,$3,$4)`,
      [version.id, c.user_id, c.role, c.share_pct]
    )
  }

  // 作品オーナーへ通知（自分以外の作品を使った場合）
  const notifySet = new Set<string>()
  const { rows: mOwner } = await db.query('SELECT creator_id FROM works WHERE id=$1', [d.melody_work_id])
  const { rows: lOwner } = await db.query('SELECT creator_id FROM works WHERE id=$1', [d.lyrics_work_id])

  for (const owner of [mOwner[0]?.creator_id, lOwner[0]?.creator_id]) {
    if (owner && owner !== req.user!.id && !notifySet.has(owner)) {
      notifySet.add(owner)
      await db.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'new_performance', $2)`,
        [owner, JSON.stringify({
          from_user_id: req.user!.id,
          version_id: version.id,
          version_title: version.title,
        })]
      )
    }
  }

  res.status(201).json(version)
})

// ── GET /api/v1/versions — フィード ──────────────────────────

versionsRouter.get('/', async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit  ?? 20), 50)
  const offset = Number(req.query.offset ?? 0)

  const { rows } = await db.query(
    `SELECT v.id, v.title, v.audio_url, v.video_external_url,
            v.play_count, v.price, v.created_at,
            mw.title AS melody_title, lw.title AS lyrics_title,
            json_agg(DISTINCT jsonb_build_object(
              'user_id', vc.user_id, 'role', vc.role,
              'share_pct', vc.share_pct, 'name', u.name
            )) AS contributors,
            COALESCE((SELECT SUM(tt.amount) FROM typ_transfers tt WHERE tt.version_id = v.id),0)::int AS total_typ,
            (SELECT COUNT(*) FROM transactions tx WHERE tx.version_id=v.id AND tx.type='purchase' AND tx.status='completed')::int AS purchase_count
     FROM versions v
     JOIN works mw ON mw.id = v.melody_work_id
     JOIN works lw ON lw.id = v.lyrics_work_id
     JOIN version_contributors vc ON vc.version_id = v.id
     JOIN users u ON u.id = vc.user_id
     GROUP BY v.id, mw.title, lw.title
     ORDER BY v.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  )
  res.json({ versions: rows, limit, offset })
})

// ── GET /api/v1/versions/:id ──────────────────────────────────

versionsRouter.get('/:id', async (req: Request, res: Response) => {
  const ref = req.query.ref as string | undefined

  const { rows } = await db.query(
    `SELECT v.id, v.title, v.audio_url, v.video_external_url,
            v.lyrics_text, v.play_count, v.price, v.created_at,
            json_agg(DISTINCT jsonb_build_object(
              'user_id', vc.user_id, 'name', u.name,
              'role', vc.role, 'share_pct', vc.share_pct
            )) AS contributors,
            json_build_object('id', mw.id, 'title', mw.title) AS melody_work,
            json_build_object('id', lw.id, 'title', lw.title) AS lyrics_work,
            COALESCE((SELECT SUM(tt.amount) FROM typ_transfers tt WHERE tt.version_id = v.id),0)::int AS total_revenue_typ,
            (SELECT COUNT(*) FROM transactions tx WHERE tx.version_id=v.id AND tx.type='purchase' AND tx.status='completed')::int AS purchase_count,
            (SELECT COUNT(*) FROM typ_transfers tt WHERE tt.version_id=v.id)::int AS tip_count
     FROM versions v
     JOIN works mw ON mw.id = v.melody_work_id
     JOIN works lw ON lw.id = v.lyrics_work_id
     JOIN version_contributors vc ON vc.version_id = v.id
     JOIN users u ON u.id = vc.user_id
     WHERE v.id=$1
     GROUP BY v.id, mw.id, lw.id`,
    [req.params.id]
  )
  if (!rows.length) return res.status(404).json({ error: 'not_found' })

  // stats をネストに整形
  const v = rows[0]
  res.json({
    ...v,
    stats: {
      total_revenue_typ: v.total_revenue_typ,
      purchase_count:    v.purchase_count,
      tip_count:         v.tip_count,
    }
  })
})

// ── POST /api/v1/versions/:id/play ───────────────────────────

versionsRouter.post('/:id/play', async (req: Request, res: Response) => {
  await db.query(
    'UPDATE versions SET play_count = play_count + 1 WHERE id=$1',
    [req.params.id]
  )
  res.json({ ok: true })
})
