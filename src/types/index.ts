// src/types/index.ts

export type UserRole = 'viewer' | 'composer' | 'lyricist' | 'musician'
export type WorkType = 'melody' | 'lyrics'
export type ReuseMode = 'open' | 'exclusive'
export type ContributorRole = 'composer' | 'lyricist' | 'musician'

export interface User {
  id: string
  name: string
  email: string
  bio: string | null
  avatar_url: string | null
  roles: UserRole[]
  convertible_balance: number
  sendable_balance: number
  wallet_address: string | null
  stripe_account_id: string | null
  scout_dm_enabled: boolean
  created_at: string
}

export interface Work {
  id: string
  creator_id: string
  type: WorkType
  title: string
  file_url: string
  bpm: number | null
  key: string | null
  reuse_mode: ReuseMode
  origin_version_id: string | null
  collab_message: string | null
  created_at: string
}

export interface Version {
  id: string
  melody_work_id: string
  lyrics_work_id: string
  title: string
  audio_url: string | null
  video_external_url: string | null
  lyrics_text: string | null
  price: number
  play_count: number
  created_at: string
}

export interface VersionContributor {
  id: string
  version_id: string
  user_id: string
  role: ContributorRole
  share_pct: number
}

// Express に user を追加
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; roles: UserRole[] }
    }
  }
}
