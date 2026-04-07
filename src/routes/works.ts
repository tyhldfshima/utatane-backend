// src/routes/works.ts
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { createHash } from 'crypto'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'

export const worksRouter = Router()

// ── GET /api/v1/works — 一覧（コラボ募集ボード兼用） ─────────

worksRouter.get('/', async (req: Request, res: Response) => {
  const type       = req.query.type as string | undefined
  const reuse_mode = req.query.reuse_mode as string | undefined
  const limit  = Math.min(Number(req.query.limit  ?? 20), 50)
  const offset = Number(req.query.offset ?? 0)

  const { rows } = await db.query(
    `SELECT w.id, w.type, w.title, w.bpm, w.key, w.reuse_mode,
            w.collab_message, w.created_at,
            json_build_object('id', u.id, 'name', u.name, 'avatar_url', u.avatar_url) AS creator,
            COUNT(DISTINCT v.id)::int AS versions_count
     FROM works w
     JOIN users u ON u.id = w.creator_id
     LEFT JOIN versions v ON (v.melody_work_id = w.id OR v.lyrics_work_id = w.id)
     WHERE ($1::text IS NULL OR w.type = $1)
       AND ($2::text IS NULL OR w.reuse_mode = $2)
     GROUP BY w.id, u.id
     ORDER BY w.created_at DESC
     LIMIT $3 OFFSET $4`,
    [type ?? null, reuse_mode ?? null, limit, offset]
  )
  res.json({ works: rows, limit, offset })
})

// ── POST /api/v1/works — 作品アップロード ────────────────────

const createSchema = z.object({
  type:              z.enum(['melody','lyrics']),
  title:             z.string().min(1).max(100),
  file_url:          z.string().url(),
  bpm:               z.number().int().positive().optional(),
  key:               z.string().max(20).optional(),
  reuse_mode:        z.enum(['open','exclusive']).default('open'),
  origin_version_id: z.string().uuid().optional(),
  collab_message:    z.string().max(300).optional(),
})

worksRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const d = parsed.data

  // ハッシュチェーン（遡及NFT用）
  const { rows: lastRow } = await db.query(
    `SELECT self_hash FROM works ORDER BY created_at DESC LIMIT 1`
  )
  const prevHash  = lastRow[0]?.self_hash ?? null
  const content   = `${req.user!.id}:${d.type}:${d.title}:${d.file_url}:${Date.now()}`
  const selfHash  = createHash('sha256')
    .update(`${content}:${prevHash ?? ''}`)
    .digest('hex')

  const { rows } = await db.query(
    `INSERT INTO works
       (creator_id, type, title, file_url, bpm, key,
        reuse_mode, origin_version_id, collab_message,
        self_hash, prev_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [req.user!.id, d.type, d.title, d.file_url,
     d.bpm ?? null, d.key ?? null,
     d.reuse_mode, d.origin_version_id ?? null, d.collab_message ?? null,
     selfHash, prevHash]
  )

  // ロール自動付与（作曲家/作詞家）
  const role = d.type === 'melody' ? 'composer' : 'lyricist'
  await db.query(
    `UPDATE users SET roles = array_append(roles, $1::text)
     WHERE id=$2 AND NOT ($1 = ANY(roles))`,
    [role, req.user!.id]
  )

  // フォロワーへ通知
  const { rows: followers } = await db.query(
    'SELECT follower_id FROM follows WHERE followee_id=$1',
    [req.user!.id]
  )
  if (followers.length) {
    const values = followers.map((_, i) =>
      `($${i * 3 + 1}, 'version_created', $${i * 3 + 2}::jsonb, $${i * 3 + 3}::uuid)`
    )
    const params = followers.flatMap(f => [
      f.follower_id,
      JSON.stringify({ from_user_id: req.user!.id, work_id: rows[0].id }),
      f.follower_id,
    ])
    // シンプルに1件ずつ insert
    for (const f of followers) {
      await db.query(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, 'version_created', $2)`,
        [f.follower_id, JSON.stringify({ from_user_id: req.user!.id, work_id: rows[0].id })]
      )
    }
  }

  res.status(201).json(rows[0])
})

// ── GET /api/v1/works/:id ─────────────────────────────────────

worksRouter.get('/:id', async (req: Request, res: Response) => {
  const meId = (req as any).user?.id ?? null

  // 作品基本情報
  const { rows: wRows } = await db.query(
    `SELECT w.*,
            json_build_object('id', u.id, 'name', u.name, 'avatar_url', u.avatar_url) AS creator
     FROM works w JOIN users u ON u.id = w.creator_id
     WHERE w.id=$1`,
    [req.params.id]
  )
  if (!wRows.length) return res.status(404).json({ error: 'not_found' })
  const work = wRows[0]

  // バージョン一覧（この作品が関係するもの）
  const { rows: vRows } = await db.query(
    `SELECT v.id, v.title, v.audio_url, v.video_external_url,
            v.play_count, v.price, v.created_at,
            -- パートナーの作品
            CASE WHEN v.melody_work_id = $1
              THEN json_build_object(
                'id', lw.id, 'title', lw.title, 'type', 'lyrics',
                'creator', json_build_object('id', lu.id, 'name', lu.name))
              ELSE json_build_object(
                'id', mw.id, 'title', mw.title, 'type', 'melody',
                'creator', json_build_object('id', mu.id, 'name', mu.name))
            END AS partner_work,
            -- ミュージシャン
            (SELECT json_build_object('id', vc.user_id, 'name', vu.name)
             FROM version_contributors vc JOIN users vu ON vu.id = vc.user_id
             WHERE vc.version_id = v.id AND vc.role='musician'
             LIMIT 1) AS musician,
            -- 統計
            COALESCE((SELECT SUM(tt.amount) FROM typ_transfers tt WHERE tt.version_id = v.id),0)::int AS typ_received,
            -- 自分の取り分（オーナーのみ）
            CASE WHEN $2::uuid IS NOT NULL AND $2 = $3
              THEN COALESCE((
                SELECT SUM(rd.amount)
                FROM revenue_distributions rd
                JOIN transactions tx ON tx.id = rd.transaction_id
                WHERE tx.version_id = v.id AND rd.user_id = $3 AND rd.status='paid'
              ),0)::int
              ELSE NULL
            END AS purchase_revenue
     FROM versions v
     JOIN works mw ON mw.id = v.melody_work_id
     JOIN users mu ON mu.id = mw.creator_id
     JOIN works lw ON lw.id = v.lyrics_work_id
     JOIN users lu ON lu.id = lw.creator_id
     WHERE v.melody_work_id=$1 OR v.lyrics_work_id=$1
     ORDER BY v.created_at ASC`,
    [req.params.id, meId, work.creator_id]
  )

  // 集計
  const totalPlays   = vRows.reduce((s: number, v: any) => s + v.play_count, 0)
  const totalTyp     = vRows.reduce((s: number, v: any) => s + (v.typ_received ?? 0), 0)
  const totalRevenue = vRows.reduce((s: number, v: any) => s + (v.purchase_revenue ?? 0), 0)

  res.json({ ...work, versions: vRows, total_plays: totalPlays, total_typ: totalTyp, total_revenue: totalRevenue })
})

// ── PATCH /api/v1/works/:id/reuse ────────────────────────────

worksRouter.patch('/:id/reuse', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({ reuse_mode: z.enum(['open','exclusive']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { rows } = await db.query(
    `UPDATE works SET reuse_mode=$1, updated_at=now()
     WHERE id=$2 AND creator_id=$3 RETURNING id, reuse_mode`,
    [parsed.data.reuse_mode, req.params.id, req.user!.id]
  )
  if (!rows.length) return res.status(404).json({ error: 'not_found_or_forbidden' })
  res.json(rows[0])
})
