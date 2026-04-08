-- 002: Stripe Checkout Session ID カラム追加
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_stripe_session_id ON transactions (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
