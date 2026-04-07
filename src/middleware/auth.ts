// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'
import { jwtVerify } from 'jose'
import { isBlacklisted } from '../redis'

const secret  = new TextEncoder().encode(process.env.JWT_SECRET!)
const rSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET!)

/** アクセストークン検証 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'no_token' })

  try {
    const { payload } = await jwtVerify(token, secret)
    const jti = payload.jti as string

    if (await isBlacklisted(jti)) {
      return res.status(401).json({ error: 'token_revoked' })
    }

    req.user = {
      id:    payload.sub as string,
      roles: payload.roles as string[],
    }
    next()
  } catch {
    res.status(401).json({ error: 'invalid_token' })
  }
}

/** ロール確認 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userRoles = req.user?.roles ?? []
    if (roles.some(r => userRoles.includes(r))) return next()
    res.status(403).json({ error: 'forbidden' })
  }
}

/** リソースオーナー確認 */
export function requireOwner(getOwnerId: (req: Request) => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ownerId = await getOwnerId(req)
    if (ownerId === req.user?.id) return next()
    res.status(403).json({ error: 'forbidden' })
  }
}
