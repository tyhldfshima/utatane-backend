-- migrations/001_initial.sql
-- ウタタネ データベーススキーマ

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── ユーザー ─────────────────────────────────────────────────

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  bio                 TEXT,
  avatar_url          TEXT,
  roles               TEXT[]    NOT NULL DEFAULT ARRAY['viewer'],
  convertible_balance INTEGER   NOT NULL DEFAULT 0,  -- 換金・送付可能TYP
  sendable_balance    INTEGER   NOT NULL DEFAULT 0,  -- 送付専用TYP（サブスク付与）
  wallet_address      TEXT,                          -- NFT用（任意）
  stripe_account_id   TEXT,                          -- Stripe Connect
  scout_dm_enabled    BOOLEAN   NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── リフレッシュトークン ──────────────────────────────────────

CREATE TABLE refresh_tokens (
  jti         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── フォロー ─────────────────────────────────────────────────

CREATE TABLE follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);

-- ── 作品（曲・詞） ────────────────────────────────────────────

CREATE TABLE works (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('melody','lyrics')),
  title            TEXT NOT NULL,
  file_url         TEXT NOT NULL,      -- S3 URL
  bpm              INTEGER,            -- 曲のみ
  key              TEXT,               -- 曲のみ
  reuse_mode       TEXT NOT NULL DEFAULT 'open'
                   CHECK (reuse_mode IN ('open','exclusive')),
  origin_version_id UUID,              -- どのバージョンの文脈で生まれたか（出自記録）
  collab_message   TEXT,
  -- ハッシュチェーン（遡及NFT用）
  self_hash        TEXT,
  prev_hash        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── バージョン（曲 × 詞 の組み合わせ） ─────────────────────────

CREATE TABLE versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  melody_work_id      UUID NOT NULL REFERENCES works(id),
  lyrics_work_id      UUID NOT NULL REFERENCES works(id),
  title               TEXT NOT NULL,
  audio_url           TEXT,            -- 完成音源
  video_external_url  TEXT,            -- YouTube URL (Phase1)
  lyrics_text         TEXT,            -- 歌詞テキスト（カラオケ用）
  price               INTEGER NOT NULL DEFAULT 300,
  play_count          INTEGER NOT NULL DEFAULT 0,
  -- ハッシュチェーン
  self_hash           TEXT,
  prev_hash           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── バージョン貢献者 ──────────────────────────────────────────

CREATE TABLE version_contributors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID    NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('composer','lyricist','musician')),
  share_pct   NUMERIC NOT NULL CHECK (share_pct > 0 AND share_pct <= 1)
);

-- ── トランザクション（購入・投げ銭） ─────────────────────────

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      UUID    NOT NULL REFERENCES versions(id),
  type            TEXT    NOT NULL CHECK (type IN ('purchase','tip')),
  amount          INTEGER NOT NULL,        -- 円
  buyer_id        UUID    REFERENCES users(id),
  referrer_id     UUID    REFERENCES users(id),  -- Phase2 リファラル
  stripe_pi_id    TEXT,                    -- Stripe PaymentIntent ID
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','failed','refunded')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 収益分配 ──────────────────────────────────────────────────

CREATE TABLE revenue_distributions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID    NOT NULL REFERENCES transactions(id),
  user_id         UUID    NOT NULL REFERENCES users(id),
  role            TEXT    NOT NULL,
  amount          INTEGER NOT NULL,        -- 分配額（円→TYP換算後）
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── TYP送付ログ ──────────────────────────────────────────────

CREATE TABLE typ_transfers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     UUID NOT NULL REFERENCES users(id),
  to_id       UUID NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  message     TEXT,
  version_id  UUID REFERENCES versions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── TYP換金申請 ──────────────────────────────────────────────

CREATE TABLE typ_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    NOT NULL REFERENCES users(id),
  amount      INTEGER NOT NULL,
  fee_amount  INTEGER NOT NULL,            -- 5% 手数料
  net_amount  INTEGER NOT NULL,
  bank_info   JSONB   NOT NULL,            -- 振込先（暗号化推奨）
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','completed','failed')),
  scheduled_at TIMESTAMPTZ,               -- 翌月15日
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 通知 ──────────────────────────────────────────────────────

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  read        BOOLEAN NOT NULL DEFAULT false,
  payload     JSONB   NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── サブスクリプション ────────────────────────────────────────

CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT    NOT NULL CHECK (plan IN ('basic','premium')),
  stripe_sub_id       TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'active',
  current_period_end  TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── インデックス ──────────────────────────────────────────────

CREATE INDEX idx_works_creator      ON works(creator_id);
CREATE INDEX idx_works_type         ON works(type);
CREATE INDEX idx_versions_melody    ON versions(melody_work_id);
CREATE INDEX idx_versions_lyrics    ON versions(lyrics_work_id);
CREATE INDEX idx_vc_version         ON version_contributors(version_id);
CREATE INDEX idx_vc_user            ON version_contributors(user_id);
CREATE INDEX idx_tx_version         ON transactions(version_id);
CREATE INDEX idx_tx_buyer           ON transactions(buyer_id);
CREATE INDEX idx_rd_transaction     ON revenue_distributions(transaction_id);
CREATE INDEX idx_rd_user            ON revenue_distributions(user_id);
CREATE INDEX idx_notif_user         ON notifications(user_id, read, created_at DESC);
CREATE INDEX idx_typ_to             ON typ_transfers(to_id);
CREATE INDEX idx_follows_followee   ON follows(followee_id);
