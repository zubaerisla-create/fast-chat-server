-- Idempotent schema, applied on every server start.

CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username         VARCHAR(30)  NOT NULL UNIQUE CHECK (char_length(username) >= 3),
  email            VARCHAR(255) NOT NULL UNIQUE,
  password_hash    TEXT         NOT NULL,
  avatar           TEXT         NOT NULL DEFAULT '',
  is_online        BOOLEAN      NOT NULL DEFAULT FALSE,
  last_seen        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expo_push_token  TEXT,
  fcm_token        TEXT,
  apns_voip_token  TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One-time codes for signup verification and password reset
CREATE TABLE IF NOT EXISTS otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(255) NOT NULL,
  purpose     VARCHAR(20)  NOT NULL CHECK (purpose IN ('register', 'reset')),
  code_hash   TEXT         NOT NULL,
  attempts    INTEGER      NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otps_email_purpose_idx ON otps (email, purpose);

-- 1-to-1 conversations; user_a < user_b keeps each pair unique regardless of order
CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS conversations_user_b_idx ON conversations (user_b);

CREATE TABLE IF NOT EXISTS messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text                 VARCHAR(2000) NOT NULL DEFAULT '',
  reply_to_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  reply_to_text        TEXT,
  reply_to_sender_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  file_url             TEXT,
  file_type            VARCHAR(10) CHECK (file_type IN ('image', 'video', 'audio', 'file')),
  file_name            TEXT,
  file_size            BIGINT,
  audio_duration       DOUBLE PRECISION,
  is_read              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id)
);

-- ─── Roles and billing (additive; safe to re-run) ────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));

-- Maps an internal user to their customer record at a billing provider.
-- Created server-side at checkout; webhooks never link a customer to a user by email alone.
CREATE TABLE IF NOT EXISTS billing_customers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              VARCHAR(20) NOT NULL CHECK (provider IN ('paddle')),
  provider_customer_id  TEXT NOT NULL,
  email                 VARCHAR(255),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_customer_id),
  UNIQUE (user_id, provider)
);

-- One row per subscription at any provider (Paddle on the web, Google Play on Android).
-- user_id is SET NULL (not cascaded) so billing history survives account deletion.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
  provider                  VARCHAR(20) NOT NULL CHECK (provider IN ('paddle', 'google_play')),
  provider_subscription_id  TEXT NOT NULL,
  provider_customer_id      TEXT,
  product_id                TEXT,
  price_id                  TEXT,
  plan                      VARCHAR(20) CHECK (plan IN ('starter', 'pro', 'advanced')),
  billing_interval          VARCHAR(10) CHECK (billing_interval IN ('month', 'year')),
  status                    VARCHAR(20) NOT NULL,
  current_period_start      TIMESTAMPTZ,
  current_period_end        TIMESTAMPTZ,
  trial_start               TIMESTAMPTZ,
  trial_end                 TIMESTAMPTZ,
  scheduled_change_action   VARCHAR(20),
  scheduled_change_at       TIMESTAMPTZ,
  canceled_at               TIMESTAMPTZ,
  past_due_since            TIMESTAMPTZ,
  currency_code             VARCHAR(3),
  recurring_amount_minor    BIGINT,
  -- Provider's own last-modified time; older events never overwrite newer state
  provider_updated_at       TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
  provider                  VARCHAR(20) NOT NULL CHECK (provider IN ('paddle')),
  provider_transaction_id   TEXT NOT NULL,
  provider_subscription_id  TEXT,
  status                    VARCHAR(20) NOT NULL,
  currency_code             VARCHAR(3),
  subtotal_minor            BIGINT,
  tax_minor                 BIGINT,
  total_minor               BIGINT,
  billed_at                 TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS billing_transactions_billed_idx ON billing_transactions (billed_at DESC);

-- Every verified webhook/notification, for idempotency and auditing (no payloads stored)
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(20) NOT NULL,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  occurred_at   TIMESTAMPTZ,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  error         TEXT,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at DESC);

-- ─── Advanced Lifetime (additive; safe to re-run) ───────────────────────────
-- Price and customer recorded on every transaction for auditing
ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;
ALTER TABLE billing_transactions ADD COLUMN IF NOT EXISTS price_id TEXT;

-- One row per paid one-time Lifetime transaction. It never expires: only an admin
-- can set status = 'revoked' (e.g. after a refund or chargeback).
CREATE TABLE IF NOT EXISTS lifetime_purchases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID REFERENCES users(id) ON DELETE SET NULL,
  provider                 VARCHAR(20) NOT NULL CHECK (provider IN ('paddle')),
  provider_transaction_id  TEXT NOT NULL,
  provider_customer_id     TEXT,
  price_id                 TEXT,
  plan                     VARCHAR(20) NOT NULL CHECK (plan IN ('advanced')),
  status                   VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  currency_code            VARCHAR(3),
  total_minor              BIGINT,
  purchased_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at               TIMESTAMPTZ,
  revoked_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_transaction_id)
);
CREATE INDEX IF NOT EXISTS lifetime_purchases_user_idx ON lifetime_purchases (user_id);

-- ═══ SaaS phase 1: conversation membership, groups, richer messages (additive) ═══
-- Every conversation type shares one membership model. Direct chats keep user_a/user_b
-- (old clients) and are mirrored into conversation_members below.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'channel'));
ALTER TABLE conversations ALTER COLUMN user_a DROP NOT NULL;
ALTER TABLE conversations ALTER COLUMN user_b DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title VARCHAR(80);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS description VARCHAR(500);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- Only admins may post (announcement groups/channels)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS admins_only_post BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS invite_code VARCHAR(40) UNIQUE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
-- Channels live in a workspace (FK added with the workspaces table); public/private channel visibility
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) CHECK (visibility IN ('public', 'private'));
CREATE INDEX IF NOT EXISTS conversations_workspace_idx ON conversations (workspace_id) WHERE workspace_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_direct_pair CHECK (type <> 'direct' OR (user_a IS NOT NULL AND user_b IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_at     TIMESTAMPTZ,
  muted_until      TIMESTAMPTZ,
  pinned_at        TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members (user_id);
-- Backfill (idempotent): existing direct chats → membership rows; last read = newest message read by them
INSERT INTO conversation_members (conversation_id, user_id, joined_at)
  SELECT c.id, u.uid, c.created_at FROM conversations c
  CROSS JOIN LATERAL (VALUES (c.user_a), (c.user_b)) AS u(uid)
  WHERE c.type = 'direct' AND u.uid IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE conversations c SET last_message_at = (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id)
  WHERE c.last_message_at IS NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
-- Deleted for everyone: content is cleared, the row stays so replies/order still make sense
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN NOT NULL DEFAULT FALSE;
-- Additional files of one multi-file message: [{url, type, name, size}]
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id VARCHAR(64);
-- System events in groups ("Ana added Ben")
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview JSONB;
DO $$ BEGIN
  ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_file_type_check;
  ALTER TABLE messages ADD CONSTRAINT messages_file_type_check CHECK (file_type IN ('image', 'video', 'audio', 'file'));
END $$;
-- Offline clients retry sends with the same client_id; it must never create a second message
CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client_idx ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conversation_cursor_idx ON messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_text_search_idx ON messages USING GIN (to_tsvector('simple', text)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS message_pins (
  message_id       UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  pinned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS message_pins_conversation_idx ON message_pins (conversation_id, pinned_at DESC);

CREATE TABLE IF NOT EXISTS message_bookmarks (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID REFERENCES messages(id) ON DELETE SET NULL,
  reporter_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  reason       VARCHAR(30) NOT NULL,
  details      VARCHAR(1000),
  status       VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- ═══ Notifications (in-app centre + preferences) ═══
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        VARCHAR(500),
  data        JSONB NOT NULL DEFAULT '{}',
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Same event never notifies the same user twice
  dedupe_key  VARCHAR(200),
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Per-category switches; a missing row means "on"
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category  VARCHAR(20) NOT NULL CHECK (category IN ('messages', 'mentions', 'groups', 'channels', 'invitations', 'tasks', 'calls', 'billing', 'status')),
  push      BOOLEAN NOT NULL DEFAULT TRUE,
  in_app    BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, category)
);

-- ═══ SaaS phase 2: organizations, workspaces, RBAC, invitations, channels, audit log ═══
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(80) NOT NULL,
  logo        TEXT,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS organizations_owner_idx ON organizations (owner_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             VARCHAR(80) NOT NULL,
  slug             VARCHAR(60) NOT NULL UNIQUE,
  description      VARCHAR(500),
  logo             TEXT,
  -- Settings: who may create channels / invite (minimum role)
  settings         JSONB NOT NULL DEFAULT '{}',
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspaces_org_idx ON workspaces (organization_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'manager', 'member', 'guest')),
  title          VARCHAR(80),
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);
-- Exactly one owner per workspace
CREATE UNIQUE INDEX IF NOT EXISTS workspace_one_owner_idx ON workspace_members (workspace_id) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  role          VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'manager', 'member', 'guest')),
  -- Only the SHA-256 of the token is stored; the token itself is only in the invite link
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  accepted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_invitations_ws_idx ON workspace_invitations (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx ON workspace_invitations (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Channel kinds: general/announcement/project/department (free-form label)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_kind VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_per_ws_idx ON conversations (workspace_id, lower(title)) WHERE type = 'channel';

-- Who did what (admin actions, membership, billing, security)
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(60) NOT NULL,
  target_type   VARCHAR(30),
  target_id     TEXT,
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  ip            VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_ws_idx ON audit_logs (workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;

-- ═══ SaaS phase 3: tasks ═══
CREATE TABLE IF NOT EXISTS tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL workspace = personal task (visible to creator and assignee only)
  workspace_id       UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id    UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  title              VARCHAR(200) NOT NULL,
  description        VARCHAR(5000),
  status             VARCHAR(12) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'review', 'completed')),
  priority           VARCHAR(8) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_at             TIMESTAMPTZ,
  assignee_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  attachments        JSONB NOT NULL DEFAULT '[]',
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_id, status);
CREATE INDEX IF NOT EXISTS tasks_creator_idx ON tasks (created_by);
CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks (workspace_id, status) WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  body        VARCHAR(2000) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments (task_id, created_at);

-- ═══ Integrated Finance Hub Module ═══
CREATE TABLE IF NOT EXISTS financial_profiles (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monthly_income                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  rent                            NUMERIC(14,2) NOT NULL DEFAULT 0,
  utilities                       NUMERIC(14,2) NOT NULL DEFAULT 0,
  subscriptions_insurance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  existing_loans                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  variable_expenses               NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_savings                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  dependents                      INT NOT NULL DEFAULT 0,
  household_responsibility_level  VARCHAR(30) NOT NULL DEFAULT 'all_or_most',
  income_stability                VARCHAR(30) NOT NULL DEFAULT 'mostly_stable',
  risk_tolerance                  VARCHAR(30) NOT NULL DEFAULT 'balanced',
  target_amount                   NUMERIC(14,2) DEFAULT 0,
  target_date                     DATE,
  goal_description                TEXT,
  total_simulations_used          INT NOT NULL DEFAULT 0,
  currency                        VARCHAR(10) NOT NULL DEFAULT 'USD',
  currency_symbol                 VARCHAR(10) NOT NULL DEFAULT '$',
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_profiles_user_idx ON financial_profiles (user_id);

CREATE TABLE IF NOT EXISTS financial_businesses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               VARCHAR(100) NOT NULL,
  description        TEXT,
  start_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  initial_investment NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_balance    NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_businesses_user_idx ON financial_businesses (user_id);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id        UUID REFERENCES financial_businesses(id) ON DELETE CASCADE,
  type               VARCHAR(20) NOT NULL CHECK (type IN ('INVESTMENT', 'PROFIT', 'SELL', 'SALE', 'EXPENSE', 'WITHDRAWAL')),
  name               VARCHAR(150) NOT NULL,
  amount             NUMERIC(14,2) NOT NULL,
  note               TEXT,
  transaction_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_transactions_user_idx ON financial_transactions (user_id);
CREATE INDEX IF NOT EXISTS financial_transactions_business_idx ON financial_transactions (business_id);
CREATE INDEX IF NOT EXISTS financial_transactions_date_idx ON financial_transactions (transaction_date DESC);

CREATE TABLE IF NOT EXISTS financial_simulations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchase_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_type       VARCHAR(20) NOT NULL DEFAULT 'full',
  loan_duration      INT NOT NULL DEFAULT 12,
  interest_rate      NUMERIC(6,2) NOT NULL DEFAULT 0,
  plan_name          VARCHAR(100),
  risk_level         VARCHAR(20) NOT NULL DEFAULT 'SAFE',
  request_payload    JSONB NOT NULL DEFAULT '{}',
  simulation_result  JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_simulations_user_idx ON financial_simulations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS financial_goals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              VARCHAR(150) NOT NULL,
  category           VARCHAR(50) NOT NULL DEFAULT 'general',
  target_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_date        DATE,
  notes              TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS financial_goals_user_idx ON financial_goals (user_id);

-- ═══ Friend / Connection Requests ═══
CREATE TABLE IF NOT EXISTS friend_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> receiver_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_pending_friend_request
  ON friend_requests (sender_id, receiver_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx ON friend_requests (receiver_id, status);
CREATE INDEX IF NOT EXISTS friend_requests_sender_idx ON friend_requests (sender_id, status);

-- ═══ Finance RevenueCat Subscriptions & 7-Day Trial ═══
CREATE TABLE IF NOT EXISTS finance_subscriptions (
  id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                            UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trial_starts_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trial_ends_at                      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  status                             VARCHAR(30) NOT NULL DEFAULT 'trialing',
  plan                               VARCHAR(30),
  revenuecat_customer_id             VARCHAR(255),
  revenuecat_original_transaction_id VARCHAR(255),
  current_period_end                 TIMESTAMPTZ,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_subs_user_idx ON finance_subscriptions (user_id);


