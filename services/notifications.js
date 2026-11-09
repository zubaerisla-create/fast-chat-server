/**
 * Unified notifications: in-app notification centre (notifications table), real-time
 * badge updates over Socket.IO, and mobile push (Expo) — each switchable per category
 * in notification_preferences. A dedupe key guarantees one notification per event per user.
 *
 * Plain new messages are push-only (the chat list already shows them); mentions,
 * invitations, tasks, calls, billing and status events also go to the in-app centre.
 * Muted conversations and blocked senders never notify. Failures never break the
 * action that triggered them.
 */
const { query } = require("../config/db");
const { emitToUsers } = require("./realtime");
const { sendPushNotification } = require("./pushNotificationService");

const CATEGORY_BY_TYPE = {
  message: "messages",
  mention: "mentions",
  group_added: "groups",
  channel_added: "channels",
  workspace_invite: "invitations",
  task_assigned: "tasks",
  task_comment: "tasks",
  task_status: "tasks",
  missed_call: "calls",
  billing: "billing",
  status_reaction: "status",
};

async function preferencesFor(userIds, category) {
  if (!userIds.length) return new Map();
  const { rows } = await query(
    "SELECT user_id, push, in_app FROM notification_preferences WHERE user_id = ANY($1::uuid[]) AND category = $2",
    [userIds, category]
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

/**
 * notify([userIds], { type, title, body, data, actorId, dedupeKey, inApp = true, push = true })
 * Returns the number of in-app notifications created.
 */
async function notify(userIds, { type, title, body = null, data = {}, actorId = null, dedupeKey = null, inApp = true, push = true }) {
  const ids = [...new Set(userIds.map(String))].filter((id) => id !== String(actorId));
  if (!ids.length) return 0;
  const category = CATEGORY_BY_TYPE[type] || "messages";
  let created = 0;
  try {
    const prefs = await preferencesFor(ids, category);
    const users = (await query("SELECT id, expo_push_token FROM users WHERE id = ANY($1::uuid[])", [ids])).rows;
    for (const u of users) {
      const pref = prefs.get(u.id) || { push: true, in_app: true };
      if (inApp && pref.in_app) {
        const { rows } = await query(
          `INSERT INTO notifications (user_id, type, title, body, data, actor_id, dedupe_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id, type, title, body, data, created_at`,
          [u.id, type, title.slice(0, 200), body ? String(body).slice(0, 500) : null, JSON.stringify(data), actorId, dedupeKey]
        );
        if (!rows[0]) continue; // duplicate event: no second notification, no second push
        created += 1;
        emitToUsers([u.id], "notification", { notification: toApi(rows[0]) });
      }
      if (push && pref.push && u.expo_push_token) {
        sendPushNotification({ to: u.expo_push_token, title, body: body || "", data: { type, ...data } }).catch((err) =>
          console.error("[Push] failed:", err.message)
        );
      }
    }
  } catch (error) {
    console.error(`[Notify] ${type} failed:`, error.message);
  }
  return created;
}

const toApi = (r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, data: r.data, readAt: r.read_at || null, createdAt: r.created_at });

const describeMessage = (message) => {
  if (message.text) return message.text.slice(0, 120);
  return { image: "sent a photo", video: "sent a video", audio: "sent a voice message" }[message.fileType] || "sent a file";
};

/** New message: push to members (not muted, not blocking the sender); in-app + push for @mentions. */
async function notifyNewMessage(conversation, message, senderId) {
  try {
    const { rows } = await query(
      `SELECT cm.user_id, u.username FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1 AND cm.user_id <> $2
         AND (cm.muted_until IS NULL OR cm.muted_until < NOW())
         AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = $2)`,
      [conversation.id, senderId]
    );
    if (!rows.length) return;
    const senderName = message.senderId?.username || "Someone";
    const where = conversation.type === "direct" ? senderName : `${senderName} in ${conversation.title || "a group"}`;
    const data = { chatId: conversation.id, conversationId: conversation.id, messageId: message.id, senderId };

    // @username mentions (groups and channels); @everyone/@channel only from owners/admins
    const mentioned = new Set();
    if (conversation.type !== "direct" && message.text) {
      const names = new Set([...message.text.matchAll(/@([A-Za-z0-9_.]{3,30})/g)].map((m) => m[1].toLowerCase()));
      const everyone = (names.has("everyone") || names.has("channel")) && ["owner", "admin"].includes(conversation.my_role);
      for (const r of rows) if (everyone || names.has(r.username.toLowerCase())) mentioned.add(r.user_id);
    }

    if (mentioned.size) {
      await notify([...mentioned], {
        type: "mention",
        title: `${senderName} mentioned you`,
        body: message.text.slice(0, 200),
        data,
        actorId: senderId,
        dedupeKey: `mention:${message.id}`,
      });
    }
    const others = rows.map((r) => r.user_id).filter((id) => !mentioned.has(id));
    await notify(others, { type: "message", title: where, body: describeMessage(message), data, actorId: senderId, inApp: false });
  } catch (error) {
    console.error("[Notify] message failed:", error.message);
  }
}

async function list(userId, { before = null, limit = 30, unreadOnly = false } = {}) {
  const { rows } = await query(
    `SELECT n.*, json_build_object('id', a.id, 'username', a.username, 'avatar', a.avatar) AS actor
     FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
     WHERE n.user_id = $1 AND ($2::timestamptz IS NULL OR n.created_at < $2) AND (NOT $3 OR n.read_at IS NULL)
     ORDER BY n.created_at DESC LIMIT $4`,
    [userId, before, unreadOnly, Math.min(Number(limit) || 30, 100)]
  );
  const unread = (await query("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [userId])).rows[0].n;
  return { notifications: rows.map((r) => ({ ...toApi(r), actor: r.actor?.id ? r.actor : null })), unread };
}

const markRead = (userId, ids = null) =>
  query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [userId, ids]
  );

const CATEGORIES = ["messages", "mentions", "groups", "channels", "invitations", "tasks", "calls", "billing", "status"];

async function getPreferences(userId) {
  const { rows } = await query("SELECT category, push, in_app FROM notification_preferences WHERE user_id = $1", [userId]);
  const byCat = new Map(rows.map((r) => [r.category, r]));
  return CATEGORIES.map((c) => ({ category: c, push: byCat.get(c)?.push ?? true, inApp: byCat.get(c)?.in_app ?? true }));
}

async function setPreference(userId, category, { push, inApp }) {
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error("Unknown category."), { status: 400 });
  await query(
    `INSERT INTO notification_preferences (user_id, category, push, in_app) VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, TRUE))
     ON CONFLICT (user_id, category) DO UPDATE SET push = COALESCE($3, notification_preferences.push), in_app = COALESCE($4, notification_preferences.in_app)`,
    [userId, category, push ?? null, inApp ?? null]
  );
  return getPreferences(userId);
}

module.exports = { notify, notifyNewMessage, list, markRead, getPreferences, setPreference, CATEGORIES };
