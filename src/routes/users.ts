// src/routes/users.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'
import { cacheDel } from '../redis'

export const usersRouter = Router()

// ── GET /api/v1/users/me ──────────────────────────────────────

usersRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { rows } = await db.query(
    `SELECT id, name, email, bio, avatar_url, roles,
            convertible_balance, sendable_balance,
            wallet_address, scout_dm_enabled, created_at
     FROM users WHERE id=$1`,
    [req.user!.id]
  )
  if (!rows.length) return res.status(404).json({ error: 'not_found' })
  res.json(rows[0])
})

// ── PUT /api/v1/users/me ──────────────────────────────────────

const updateSchema = z.object({
  name:             z.string().min(1).max(50).optional(),
  bio:              z.string().max(200).optional(),
  scout_dm_enabled: z.boolean().optional(),
})

usersRouter.put('/me', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { name, bio, scout_dm_enabled } = parsed.data
  const { rows } = await db.query(
    `UPDATE users SET
       name             = COALESCE($1, name),
       bio              = COALESCE($2, bio),
       scout_dm_enabled = COALESCE($3, scout_dm_enabled),
       updated_at       = now()
     WHERE id=$4
     RETURNING id, name, bio, roles, convertible_balance, sendable_balance, scout_dm_enabled`,
    [name, bio, scout_dm_enabled, req.user!.id]
  )
  res.json(rows[0])
})

// ── PATCH /api/v1/users/me/roles ─────────────────────────────
// ミュージシャン登録など、ロールを追加する

usersRouter.patch('/me/roles', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({
    role: z.enum(['composer', 'lyricist', 'musician'])
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { role } = parsed.data
  const { rows } = await db.query(
    `UPDATE users
     SET roles = array_append(roles, $1::text), updated_at = now()
     WHERE id=$2 AND NOT ($1 = ANY(roles))
     RETURNING id, name, roles`,
    [role, req.user!.id]
  )
  if (!rows.length) {
    // すでに持っているロールの場合は現状を返す
    const { rows: cur } = await db.query('SELECT id,name,roles FROM users WHERE id=$1', [req.user!.id])
    return res.json(cur[0])
  }
  res.json(rows[0])
})

// ── GET /api/v1/users/:id ─────────────────────────────────────

usersRouter.get('/:id', async (req: Request, res: Response) => {
  const meId = (req as any).user?.id ?? null

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.bio, u.avatar_url, u.roles, u.scout_dm_enabled,
            u.created_at,
            (SELECT COUNT(*) FROM works   WHERE creator_id = u.id)::int  AS works_count,
            (SELECT COUNT(*) FROM version_contributors WHERE user_id = u.id)::int AS versions_count,
            (SELECT COUNT(*) FROM follows WHERE followee_id = u.id)::int AS followers_count,
            (SELECT COUNT(*) FROM follows WHERE follower_id = u.id)::int AS following_count,
            COALESCE((SELECT SUM(amount) FROM typ_transfers WHERE to_id = u.id),0)::int AS total_typ_earned,
            CASE WHEN $2::uuid IS NOT NULL
              THEN EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND followee_id=u.id)
              ELSE false
            END AS is_following
     FROM users u WHERE u.id=$1`,
    [req.params.id, meId]
  )
  if (!rows.length) return res.status(404).json({ error: 'not_found' })
  res.json(rows[0])
})

// ── GET /api/v1/users/:id/works ───────────────────────────────

usersRouter.get('/:id/works', async (req: Request, res: Response) => {
  const meId = (req as any).user?.id ?? null
  const isMine = meId === req.params.id

  const { rows } = await db.query(
    `SELECT w.id, w.type, w.title, w.bpm, w.key, w.reuse_mode,
            w.collab_message, w.created_at,
            COUNT(DISTINCT v.id)::int AS versions_count,
            COALESCE(SUM(v.play_count),0)::int AS play_count,
            -- オーナーのみ収益情報
            CASE WHEN $2 THEN
              COALESCE((
                SELECT SUM(rd.amount)
                FROM revenue_distributions rd
                JOIN transactions tx ON tx.id = rd.transaction_id
                JOIN versions v2 ON v2.id = tx.version_id
                WHERE rd.user_id = w.creator_id
                  AND (v2.melody_work_id = w.id OR v2.lyrics_work_id = w.id)
                  AND rd.status = 'paid'
              ),0)::int
              ELSE NULL
            END AS total_revenue,
            CASE WHEN $2 THEN
              COALESCE((
                SELECT SUM(tt.amount)
                FROM typ_transfers tt
                JOIN versions v2 ON v2.id = tt.version_id
                WHERE tt.to_id = w.creator_id
                  AND (v2.melody_work_id = w.id OR v2.lyrics_work_id = w.id)
              ),0)::int
              ELSE NULL
            END AS total_typ
     FROM works w
     LEFT JOIN versions v
       ON (v.melody_work_id = w.id OR v.lyrics_work_id = w.id)
     WHERE w.creator_id = $1
     GROUP BY w.id
     ORDER BY w.created_at DESC`,
    [req.params.id, isMine]
  )
  res.json({ works: rows })
})

// ── GET /api/v1/users/:id/versions ────────────────────────────

usersRouter.get('/:id/versions', async (req: Request, res: Response) => {
  const { rows } = await db.query(
    `SELECT v.id, v.title, v.audio_url, v.video_external_url,
            v.play_count, v.price, v.created_at,
            json_agg(json_build_object(
              'user_id', vc.user_id, 'role', vc.role, 'share_pct', vc.share_pct,
              'name', u2.name
            )) AS contributors,
            COALESCE((SELECT SUM(tt.amount) FROM typ_transfers tt WHERE tt.version_id = v.id AND tt.to_id=$1),0)::int AS total_typ_received,
            (SELECT COUNT(*) FROM transactions tx WHERE tx.version_id = v.id AND tx.type='purchase' AND tx.status='completed')::int AS purchase_count
     FROM versions v
     JOIN version_contributors vc ON vc.version_id = v.id AND vc.user_id = $1
     JOIN version_contributors vc2 ON vc2.version_id = v.id
     JOIN users u2 ON u2.id = vc2.user_id
     WHERE vc.user_id = $1
     GROUP BY v.id
     ORDER BY v.created_at DESC`,
    [req.params.id]
  )
  res.json({ versions: rows })
})

// ── POST/DELETE /api/v1/users/:id/follow ─────────────────────

usersRouter.post('/:id/follow', requireAuth, async (req: Request, res: Response) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'cannot_follow_self' })

  await db.query(
    'INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.user!.id, req.params.id]
  )

  // 通知を作成
  await db.query(
    `INSERT INTO notifications (user_id, type, payload)
     VALUES ($1, 'new_follower', $2)`,
    [req.params.id, JSON.stringify({ from_user_id: req.user!.id })]
  )

  res.json({ ok: true })
})

usersRouter.delete('/:id/follow', requireAuth, async (req: Request, res: Response) => {
  await db.query(
    'DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2',
    [req.user!.id, req.params.id]
  )
  res.json({ ok: true })
})
