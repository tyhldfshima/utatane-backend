// src/routes/notifications.ts
import { Router, Request, Response } from 'express'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'

export const notificationsRouter = Router()

// ── GET /api/v1/notifications ─────────────────────────────────

notificationsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit ?? 30), 100)
  const offset = Number(req.query.offset ?? 0)

  const { rows } = await db.query(
    `SELECT n.id, n.type, n.read, n.payload, n.created_at,
            -- from_user 情報を JOIN で解決
            CASE WHEN n.payload->>'from_user_id' IS NOT NULL
              THEN json_build_object(
                'id',   u.id,
                'name', u.name,
                'avatar_url', u.avatar_url
              )
              ELSE NULL
            END AS from_user
     FROM notifications n
     LEFT JOIN users u ON u.id = (n.payload->>'from_user_id')::uuid
     WHERE n.user_id=$1
     ORDER BY n.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user!.id, limit, offset]
  )

  const unread_count = rows.filter(n => !n.read).length
  res.json({ notifications: rows, unread_count, limit, offset })
})

// ── POST /api/v1/notifications/:id/read ──────────────────────

notificationsRouter.post('/:id/read', requireAuth, async (req: Request, res: Response) => {
  await db.query(
    'UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user!.id]
  )
  res.json({ ok: true })
})

// ── POST /api/v1/notifications/read-all ──────────────────────

notificationsRouter.post('/read-all', requireAuth, async (req: Request, res: Response) => {
  await db.query(
    'UPDATE notifications SET read=true WHERE user_id=$1 AND read=false',
    [req.user!.id]
  )
  res.json({ ok: true })
})
