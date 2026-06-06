-- ============================================================
-- 052: Store Stripe session_id on purchases for webhook lookup
-- Fixes two bugs in the Stripe payment flow:
--
-- Bug A — Billboard multi-purchase maybeSingle() collision:
--   Webhook looked up pending row by (developer_id, item_id).
--   Billboard allows multiple concurrent pending rows →
--   maybeSingle() throws 406 → swallowed by try/catch →
--   200 returned → Stripe never retries → payment permanently lost.
--
-- Bug B — Retry pending-delete destroys webhook join key:
--   Checkout route deleted pending row on retry → original
--   session's webhook finds no pending row → fallback creates
--   completed purchase without gifted_to metadata.
--
-- Fix:
--   1. Add stripe_session_id column to purchases.
--   2. Change "pending delete on retry" to soft-update to
--      "abandoned" status so the row survives for webhook delivery.
-- ============================================================

-- ─── 1. Add stripe_session_id column ────────────────────────
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;

-- Index for webhook O(1) lookup by session ID
CREATE INDEX IF NOT EXISTS idx_purchases_stripe_session_id
  ON public.purchases (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- ─── 2. Add "abandoned" as a valid purchase status ──────────
-- Existing constraint may enumerate statuses — extend it.
-- Using DO $$ to guard against "constraint does not exist" on
-- older DB instances that never had a status CHECK constraint.
DO $$
BEGIN
  -- Drop and recreate the status check if it exists and doesn't include abandoned
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchases_status_check'
    AND conrelid = 'public.purchases'::regclass
  ) THEN
    ALTER TABLE public.purchases DROP CONSTRAINT purchases_status_check;
    ALTER TABLE public.purchases ADD CONSTRAINT purchases_status_check
      CHECK (status IN ('pending', 'completed', 'refunded', 'failed', 'consumed', 'abandoned'));
  END IF;
END $$;