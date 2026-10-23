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
