/**
 * Central plan-limit enforcement (server-side only; the UI just displays results).
 *
 * - Personal limits (file size, storage, AI requests, workspaces owned) follow the
 *   user's own entitlement.
 * - Workspace limits (members, channels, group calls) follow the entitlement of the
 *   workspace's organization owner — the person who pays for the team.
 *
 * Violations throw an error with status 402 and code "limit_reached", plus the limit
 * and current usage so clients can show an upgrade prompt.
 */
const { query } = require("../config/db");
const { getEntitlement } = require("./entitlements");

const limitError = (message, { limit, used, key }) =>
  Object.assign(new Error(message), { status: 402, code: "limit_reached", details: { key, limit, used } });

async function workspaceOwnerEntitlement(workspaceId, db = { query }) {
  const { rows } = await db.query(
    "SELECT o.owner_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = $1",
    [workspaceId]
  );
  return rows[0]?.owner_id ? getEntitlement(rows[0].owner_id) : getEntitlement(null);
}

async function assertCanCreateWorkspace(userId) {
  const ent = await getEntitlement(userId);
  const limit = ent.limits.workspaces;
  if (limit === null) return;
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE o.owner_id = $1",
    [userId]
  );
  if (rows[0].n >= limit) {
    throw limitError(`Your ${ent.planName === "Free" ? "current" : ent.planName} plan allows ${limit} workspace${limit === 1 ? "" : "s"}. Upgrade to create more.`, { key: "workspaces", limit, used: rows[0].n });
  }
}

/** Members + pending invitations must stay within the owner's plan. */
async function assertCanAddMembers(workspaceId, count = 1, db = { query }) {
  const ent = await workspaceOwnerEntitlement(workspaceId, db);
  const limit = ent.limits.membersPerWorkspace;
  if (limit === null) return;
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1)
          + (SELECT COUNT(*) FROM workspace_invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS n`,
    [workspaceId]
  );
  const used = Number(rows[0].n);
  if (used + count > limit) {
    throw limitError(`This workspace's plan allows ${limit} members (including pending invitations). The owner can upgrade for more.`, { key: "membersPerWorkspace", limit, used });
  }
}

async function assertCanCreateChannel(workspaceId) {
  const ent = await workspaceOwnerEntitlement(workspaceId);
  const limit = ent.limits.channelsPerWorkspace;
  if (limit === null) return;
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM conversations WHERE workspace_id = $1 AND type = 'channel'", [workspaceId]);
  if (rows[0].n >= limit) {
    throw limitError(`This workspace's plan allows ${limit} channels. The owner can upgrade for more.`, { key: "channelsPerWorkspace", limit, used: rows[0].n });
  }
}

/** Bytes of files the user has sent (live messages only). */
async function storageUsedBy(userId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(COALESCE(file_size, 0) + COALESCE((SELECT SUM((a->>'size')::bigint) FROM jsonb_array_elements(attachments) a), 0)), 0)::bigint AS bytes
     FROM messages WHERE sender_id = $1 AND deleted_at IS NULL AND (file_url IS NOT NULL OR attachments IS NOT NULL)`,
    [userId]
  );
  return Number(rows[0].bytes);
}

async function assertStorageAvailable(userId, incomingBytes) {
  const ent = await getEntitlement(userId);
  const limit = ent.limits.storageBytes;
  if (limit === null) return;
  const used = await storageUsedBy(userId);
  if (used + incomingBytes > limit) {
    throw limitError("You've used all the file storage on your plan. Delete old files or upgrade for more space.", { key: "storageBytes", limit, used });
  }
}

/** Express helper: send a limit error (or rethrow anything else). */
function sendLimitError(res, error) {
  if (error.code !== "limit_reached") return false;
  res.status(402).json({ success: false, code: error.code, message: error.message, ...error.details });
  return true;
}

module.exports = {
  workspaceOwnerEntitlement,
  assertCanCreateWorkspace,
  assertCanAddMembers,
  assertCanCreateChannel,
  assertStorageAvailable,
  storageUsedBy,
  sendLimitError,
};
