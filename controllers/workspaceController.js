const Workspace = require("../models/Workspace");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const { withTransaction } = require("../config/db");
const rbac = require("../services/rbac");
const limits = require("../services/limits");
const { audit } = require("../services/audit");
const notifications = require("../services/notifications");
const { emitToUsers, emitToConversation } = require("../services/realtime");
const { sendInvitationEmail } = require("../utils/mailer");
const { systemMessage } = require("./conversationController");

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, code });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanName = (v, max = 80) => String(v || "").trim().slice(0, max);
const siteUrl = () => (process.env.CLIENT_URL || process.env.SITE_URL || "http://localhost:3000").split(",")[0].replace(/\/$/, "");

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (limits.sendLimitError(res, error)) return;
    if (error.code === "23505") return fail(res, 409, "That name is already taken in this workspace.");
    next(error);
  }
};

/** Loads the workspace and the caller's role; enforces a permission. Returns the row or null (response sent). */
async function access(req, res, permission = "workspace.view") {
  const ws = await Workspace.membership(req.params.id, req.user._id);
  if (!ws || !ws.my_role) {
    fail(res, 404, "Workspace not found.");
    return null;
  }
  if (!rbac.can(ws.my_role, permission, ws.settings)) {
    fail(res, 403, "You don't have permission to do that in this workspace.", "forbidden");
    return null;
  }
  Workspace.touch(ws.id, req.user._id).catch(() => {});
  return ws;
}

const permissionsFor = (role, settings) => Object.fromEntries(Object.keys(rbac.PERMISSIONS).map((p) => [p, rbac.can(role, p, settings)]));

// ─── Organizations ───────────────────────────────────────────────────────────

const listOrganizations = handle(async (req, res) => {
  res.json({ success: true, organizations: await Workspace.listOrganizations(req.user._id) });
});

/** PATCH /api/organizations/:orgId { name?, logo? } — organization owner only. */
const updateOrganization = handle(async (req, res) => {
  const org = await Workspace.getOrganization(req.params.orgId);
  if (!org || org.owner_id !== req.user._id) return fail(res, 404, "Organization not found.");
  const name = req.body?.name !== undefined ? cleanName(req.body.name) : undefined;
  if (name === "") return fail(res, 400, "Name can't be empty.");
  const logo = req.body?.logo !== undefined ? (typeof req.body.logo === "string" && /^https?:\/\//.test(req.body.logo) ? req.body.logo : null) : undefined;
  await Workspace.updateOrganization(org.id, { name, logo });
  await audit(req, "organization.update", { targetType: "organization", targetId: org.id, metadata: { name } });
  res.json({ success: true, organizations: await Workspace.listOrganizations(req.user._id) });
});

// ─── Workspaces ──────────────────────────────────────────────────────────────

/** POST /api/workspaces { name, description?, organizationId? } */
const createWorkspace = handle(async (req, res) => {
  const name = cleanName(req.body?.name);
  if (name.length < 2) return fail(res, 400, "Workspace name must be at least 2 characters.");
  let organizationId = req.body?.organizationId || null;
  if (organizationId) {
    const org = await Workspace.getOrganization(organizationId);
    if (!org || org.owner_id !== req.user._id) return fail(res, 403, "Only the organization owner can add workspaces to it.");
  }
  await limits.assertCanCreateWorkspace(req.user._id);
  const id = await Workspace.create({ name, description: cleanName(req.body?.description, 500) || null, organizationId, ownerId: req.user._id });
  await audit(req, "workspace.create", { targetType: "workspace", targetId: id, workspaceId: id, metadata: { name } });
  res.status(201).json({ success: true, workspace: await Workspace.get(id, req.user._id) });
});

const listWorkspaces = handle(async (req, res) => {
  res.json({ success: true, workspaces: await Workspace.listForUser(req.user._id) });
});

const getWorkspace = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const workspace = await Workspace.get(ws.id, req.user._id);
  const ownerEnt = await limits.workspaceOwnerEntitlement(ws.id);
  res.json({
    success: true,
    workspace,
    permissions: permissionsFor(ws.my_role, ws.settings),
    assignableRoles: rbac.assignableRoles(ws.my_role),
    plan: { id: ownerEnt.plan, name: ownerEnt.planName, limits: { membersPerWorkspace: ownerEnt.limits.membersPerWorkspace, channelsPerWorkspace: ownerEnt.limits.channelsPerWorkspace, groupCalls: ownerEnt.limits.groupCalls } },
  });
});

/** PATCH /api/workspaces/:id { name?, description?, logo?, settings? } — admin+. */
const updateWorkspace = handle(async (req, res) => {
  const ws = await access(req, res, "workspace.update");
  if (!ws) return;
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) {
    fields.name = cleanName(b.name);
    if (fields.name.length < 2) return fail(res, 400, "Workspace name must be at least 2 characters.");
  }
  if (b.description !== undefined) fields.description = cleanName(b.description, 500) || null;
  if (b.logo !== undefined) fields.logo = typeof b.logo === "string" && /^https?:\/\//.test(b.logo) ? b.logo.slice(0, 1000) : null;
  if (b.settings && typeof b.settings === "object") {
    const allowed = {};
    for (const key of ["minInviteRole", "minChannelCreateRole"]) {
      if (b.settings[key] !== undefined) {
        if (!["member", "manager", "admin"].includes(b.settings[key])) return fail(res, 400, `${key} must be member, manager or admin.`);
        allowed[key] = b.settings[key];
      }
    }
    fields.settings = { ...ws.settings, ...allowed };
  }
  await Workspace.update(ws.id, fields);
  await audit(req, "workspace.update", { targetType: "workspace", targetId: ws.id, workspaceId: ws.id, metadata: { fields: Object.keys(fields) } });
  emitToUsers((await Workspace.listMembers(ws.id, { limit: 200 })).members.map((m) => m.id), "workspaceUpdated", { workspaceId: ws.id });
  res.json({ success: true, workspace: await Workspace.get(ws.id, req.user._id) });
});

/** DELETE /api/workspaces/:id { confirm: <workspace name> } — owner only, deletes channels and their messages. */
const deleteWorkspace = handle(async (req, res) => {
  const ws = await access(req, res, "workspace.delete");
  if (!ws) return;
  if (req.body?.confirm !== ws.name) return fail(res, 400, "Type the workspace name to confirm deletion.");
  const memberIds = (await Workspace.listMembers(ws.id, { limit: 200 })).members.map((m) => m.id);
  await audit(req, "workspace.delete", { targetType: "workspace", targetId: ws.id, metadata: { name: ws.name } });
  await Workspace.remove(ws.id);
  emitToUsers(memberIds, "workspaceRemoved", { workspaceId: ws.id });
  res.json({ success: true });
});

/** POST /api/workspaces/:id/transfer { userId } — owner hands ownership to another non-guest member. */
const transferOwnership = handle(async (req, res) => {
  const ws = await access(req, res, "workspace.transfer");
  if (!ws) return;
  const target = await Workspace.getMember(ws.id, req.body?.userId);
  if (!target || target.user_id === req.user._id) return fail(res, 400, "Choose another member of this workspace.");
  if (target.role === "guest") return fail(res, 400, "Guests can't own a workspace. Change their role first.");
  await Workspace.transferOwnership(ws.id, req.user._id, target.user_id);
  await audit(req, "workspace.transfer", { targetType: "user", targetId: target.user_id, workspaceId: ws.id });
  res.json({ success: true, workspace: await Workspace.get(ws.id, req.user._id) });
});

// ─── Members ─────────────────────────────────────────────────────────────────

const listMembers = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const result = await Workspace.listMembers(ws.id, { q: req.query.q || "", limit: req.query.limit, offset: req.query.offset });
  // Guests see names only, not emails
  if (!rbac.can(ws.my_role, "members.view")) result.members = result.members.map(({ email, ...m }) => m);
  res.json({ success: true, ...result });
});

/** PATCH /api/workspaces/:id/members/:userId { role?, title? } */
const updateMember = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const target = await Workspace.getMember(ws.id, req.params.userId);
  if (!target) return fail(res, 404, "Member not found.");
  const { role, title } = req.body || {};
  const self = target.user_id === req.user._id;

  if (role !== undefined) {
    if (!rbac.can(ws.my_role, "members.role")) return fail(res, 403, "Only admins can change roles.");
    if (self) return fail(res, 400, "You can't change your own role.");
    if (role === "owner") return fail(res, 400, "Use ownership transfer to make someone the owner.");
    if (!rbac.ROLES.includes(role)) return fail(res, 400, "Invalid role.");
    if (!rbac.outranks(ws.my_role, target.role) || !rbac.assignableRoles(ws.my_role).includes(role)) {
      return fail(res, 403, "You can only change roles below your own.");
    }
  }
  if (title !== undefined && !self && !rbac.can(ws.my_role, "members.role")) return fail(res, 403, "You can only change your own title.");

  await Workspace.setMember(ws.id, target.user_id, { role, title: title === undefined ? undefined : cleanName(title) || null });
  if (role === "guest") {
    // Guests keep only channels they were explicitly added to; drop default channels
    await require("../config/db").query(
      `DELETE FROM conversation_members WHERE user_id = $2 AND conversation_id IN
        (SELECT id FROM conversations WHERE workspace_id = $1 AND channel_kind IN ('general', 'announcement'))`,
      [ws.id, target.user_id]
    );
  }
  if (role) await audit(req, "member.role", { targetType: "user", targetId: target.user_id, workspaceId: ws.id, metadata: { from: target.role, to: role } });
  res.json({ success: true, members: (await Workspace.listMembers(ws.id, { limit: 200 })).members });
});

/** DELETE /api/workspaces/:id/members/:userId — admins remove lower roles; anyone but the owner may leave. */
const removeMember = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const target = await Workspace.getMember(ws.id, req.params.userId);
  if (!target) return fail(res, 404, "Member not found.");
  const self = target.user_id === req.user._id;
  if (self && target.role === "owner") return fail(res, 400, "Transfer ownership before leaving the workspace.");
  if (!self && (!rbac.can(ws.my_role, "members.remove") || !rbac.outranks(ws.my_role, target.role))) {
    return fail(res, 403, "You can't remove this member.");
  }
  await Workspace.removeMember(ws.id, target.user_id);
  await audit(req, self ? "member.leave" : "member.remove", { targetType: "user", targetId: target.user_id, workspaceId: ws.id });
  emitToUsers([target.user_id], "workspaceRemoved", { workspaceId: ws.id });
  res.json({ success: true });
});

// ─── Invitations ─────────────────────────────────────────────────────────────

/**
 * POST /api/workspaces/:id/invitations { emails: [], role }
 * Each invite is emailed (or logged in dev) and its link returned so it can be shared manually.
 */
const inviteMembers = handle(async (req, res) => {
  const ws = await access(req, res, "members.invite");
  if (!ws) return;
  const role = req.body?.role || "member";
  if (!rbac.assignableRoles(ws.my_role).includes(role)) return fail(res, 403, "You can't invite people with that role.");
  const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : [req.body?.email]).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))].slice(0, 50);
  if (!emails.length || emails.some((e) => !EMAIL_RE.test(e) || e.length > 255)) return fail(res, 400, "Enter valid email addresses.");

  // Skip people who are already members
  const existing = new Set((await Workspace.listMembers(ws.id, { limit: 200 })).members.map((m) => m.email.toLowerCase()));
  const toInvite = emails.filter((e) => !existing.has(e));
  if (!toInvite.length) return fail(res, 400, "Everyone on that list is already a member.");

  const created = await withTransaction(async (db) => {
    await limits.assertCanAddMembers(ws.id, toInvite.length, db);
    const out = [];
    for (const email of toInvite) out.push({ email, ...(await Workspace.createInvitation(db, { workspaceId: ws.id, email, role, invitedBy: req.user._id })) });
    return out;
  });

  const results = [];
  for (const { email, invitation, token } of created) {
    const link = `${siteUrl()}/invite/${token}`;
    let emailed = true;
    try {
      await sendInvitationEmail(email, { workspaceName: ws.name, inviterName: req.user.username, role, link, days: Workspace.INVITE_DAYS });
    } catch (error) {
      emailed = false;
      console.error("[Invite] email failed:", error.message);
    }
    const user = await User.findByEmail(email);
    if (user) {
      await notifications.notify([user._id], {
        type: "workspace_invite",
        title: `${req.user.username} invited you to ${ws.name}`,
        body: `Join as ${role}`,
        data: { workspaceId: ws.id, invitationId: invitation.id },
        actorId: req.user._id,
        dedupeKey: `invite:${invitation.id}`,
      });
    }
    results.push({ id: invitation.id, email, role, expiresAt: invitation.expires_at, link, emailed });
  }
  await audit(req, "member.invite", { workspaceId: ws.id, metadata: { emails: toInvite, role } });
  res.status(201).json({ success: true, invitations: results });
});

const listInvitations = handle(async (req, res) => {
  const ws = await access(req, res, "members.invite");
  if (!ws) return;
  res.json({ success: true, invitations: await Workspace.listInvitations(ws.id) });
});

const revokeInvitation = handle(async (req, res) => {
  const ws = await access(req, res, "members.invite");
  if (!ws) return;
  await Workspace.revokeInvitation(ws.id, req.params.invitationId);
  await audit(req, "member.invite_revoke", { targetType: "invitation", targetId: req.params.invitationId, workspaceId: ws.id });
  res.json({ success: true });
});

/** GET /api/invitations/:token — public preview (no email revealed beyond a mask). */
const previewInvitation = handle(async (req, res) => {
  const inv = await Workspace.invitationByToken(req.params.token);
  if (!inv) return fail(res, 404, "This invitation link is invalid.");
  const state = inv.revoked_at ? "revoked" : inv.accepted_at ? "accepted" : new Date(inv.expires_at) < new Date() ? "expired" : "pending";
  const [name, domain] = inv.email.split("@");
  res.json({
    success: true,
    invitation: { state, role: inv.role, workspace: { id: inv.workspace_id, name: inv.workspace_name, logo: inv.workspace_logo }, invitedBy: inv.inviter_name, email: `${name.slice(0, 2)}•••@${domain}`, expiresAt: inv.expires_at },
  });
});

/** POST /api/invitations/:token/accept — only the invited email address can accept. */
const acceptInvitation = handle(async (req, res) => {
  const inv = await Workspace.invitationByToken(req.params.token);
  if (!inv) return fail(res, 404, "This invitation link is invalid.");
  if (inv.email.toLowerCase() !== String(req.user.email).toLowerCase()) {
    return fail(res, 403, "This invitation was sent to a different email address. Sign in with that account to accept it.", "wrong_account");
  }
  if (await Workspace.getMember(inv.workspace_id, req.user._id)) {
    return res.json({ success: true, workspace: await Workspace.get(inv.workspace_id, req.user._id), alreadyMember: true });
  }
  const workspaceId = await Workspace.acceptInvitation(inv.id, req.user._id);
  if (!workspaceId) return fail(res, 410, "This invitation has expired or was revoked. Ask for a new one.", "invitation_gone");
  await audit({ ...req }, "member.join", { targetType: "user", targetId: req.user._id, workspaceId, metadata: { role: inv.role } });
  res.json({ success: true, workspace: await Workspace.get(workspaceId, req.user._id) });
});

/** GET /api/invitations — pending invitations for the signed-in user's email. */
const myInvitations = handle(async (req, res) => {
  res.json({ success: true, invitations: await Workspace.pendingInvitationsForEmail(req.user.email) });
});

/** POST /api/invitations/id/:invitationId/accept — accept from the in-app list (same email rule). */
const acceptInvitationById = handle(async (req, res) => {
  const pending = await Workspace.pendingInvitationsForEmail(req.user.email);
  const inv = pending.find((i) => i.id === req.params.invitationId);
  if (!inv) return fail(res, 404, "Invitation not found or no longer valid.");
  const workspaceId = await Workspace.acceptInvitation(inv.id, req.user._id);
  if (!workspaceId) return fail(res, 410, "This invitation has expired or was revoked.");
  await audit(req, "member.join", { targetType: "user", targetId: req.user._id, workspaceId, metadata: { role: inv.role } });
  res.json({ success: true, workspace: await Workspace.get(workspaceId, req.user._id) });
});

// ─── Channels ────────────────────────────────────────────────────────────────

const listChannels = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  res.json({ success: true, channels: await Workspace.listChannels(ws.id, req.user._id, { includeBrowsable: rbac.can(ws.my_role, "channels.browse") }) });
});

/** POST /api/workspaces/:id/channels { name, description?, visibility?, kind?, adminsOnlyPost?, memberIds? } */
const createChannel = handle(async (req, res) => {
  const ws = await access(req, res, "channels.create");
  if (!ws) return;
  const name = Workspace.channelName(req.body?.name);
  if (!name) return fail(res, 400, "Channel names can use letters, numbers, - and _.");
  if (await Workspace.channelExists(ws.id, name)) return fail(res, 409, `#${name} already exists.`);
  await limits.assertCanCreateChannel(ws.id);
  const visibility = req.body?.visibility === "private" ? "private" : "public";
  const kind = ["project", "department", "announcement", "topic"].includes(req.body?.kind) ? req.body.kind : "topic";
  // Only workspace members (not the creator) can be added
  const requested = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(String).slice(0, 200) : [];
  const valid = [];
  for (const id of requested) if (await Workspace.getMember(ws.id, id)) valid.push(id);

  const channel = await Conversation.createGroup({
    creatorId: req.user._id,
    title: name,
    description: req.body?.description ? String(req.body.description).slice(0, 500) : null,
    memberIds: valid,
    workspaceId: ws.id,
    type: "channel",
    visibility,
    adminsOnlyPost: kind === "announcement" || Boolean(req.body?.adminsOnlyPost),
  });
  await require("../config/db").query("UPDATE conversations SET channel_kind = $2 WHERE id = $1", [channel.id, kind]);
  await systemMessage(channel.id, req.user._id, `${req.user.username} created #${name}`);
  await audit(req, "channel.create", { targetType: "channel", targetId: channel.id, workspaceId: ws.id, metadata: { name, visibility } });
  emitToUsers(valid, "conversationAdded", { conversationId: channel.id, workspaceId: ws.id });
  if (valid.length) {
    await notifications.notify(valid, { type: "channel_added", title: `${req.user.username} added you to #${name}`, data: { conversationId: channel.id, workspaceId: ws.id }, actorId: req.user._id, dedupeKey: `channel_added:${channel.id}` });
  }
  res.status(201).json({ success: true, channel: (await Workspace.listChannels(ws.id, req.user._id, { includeBrowsable: false })).find((c) => c.id === channel.id) });
});

async function channelAccess(req, res, ws) {
  const channel = await Workspace.getChannel(ws.id, req.params.channelId);
  if (!channel) {
    fail(res, 404, "Channel not found.");
    return null;
  }
  const member = await Conversation.getMember(channel.id, req.user._id);
  // Private channels are invisible to non-members
  if (channel.visibility === "private" && !member) {
    fail(res, 404, "Channel not found.");
    return null;
  }
  const canManage = rbac.can(ws.my_role, "channels.manage") || ["owner", "admin"].includes(member?.role);
  return { channel, member, canManage };
}

/** POST /api/workspaces/:id/channels/:channelId/join — public channels, members and above. */
const joinChannel = handle(async (req, res) => {
  const ws = await access(req, res, "channels.browse");
  if (!ws) return;
  const ctx = await channelAccess(req, res, ws);
  if (!ctx) return;
  if (ctx.channel.visibility !== "public") return fail(res, 403, "This channel is private.");
  if (!ctx.member) {
    await Conversation.addMembers(ctx.channel.id, [req.user._id]);
    await systemMessage(ctx.channel.id, req.user._id, `${req.user.username} joined #${ctx.channel.title}`);
  }
  res.json({ success: true, conversation: await Conversation.getFull(ctx.channel.id, req.user._id) });
});

const leaveChannel = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const ctx = await channelAccess(req, res, ws);
  if (!ctx) return;
  if (ctx.channel.channel_kind === "general") return fail(res, 400, "Everyone stays in #general.");
  if (ctx.member) {
    await Conversation.removeMember(ctx.channel.id, req.user._id);
    if (ctx.member.role === "owner") {
      const next = await Conversation.successor(ctx.channel.id, req.user._id);
      if (next) await Conversation.setRole(ctx.channel.id, next, "owner");
    }
    await systemMessage(ctx.channel.id, req.user._id, `${req.user.username} left #${ctx.channel.title}`);
  }
  res.json({ success: true });
});

/** POST /api/workspaces/:id/channels/:channelId/members { userIds } — channel admins or workspace managers. */
const addChannelMembers = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const ctx = await channelAccess(req, res, ws);
  if (!ctx) return;
  if (!ctx.canManage && !(ctx.member && ctx.channel.visibility === "public")) return fail(res, 403, "You can't add people to this channel.");
  const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String).slice(0, 100) : [];
  const valid = [];
  for (const id of ids) if (await Workspace.getMember(ws.id, id)) valid.push(id);
  const added = await Conversation.addMembers(ctx.channel.id, valid);
  if (added.length) {
    const names = (await Promise.all(added.map((id) => User.findById(id)))).map((u) => u.username);
    await systemMessage(ctx.channel.id, req.user._id, `${req.user.username} added ${names.join(", ")}`);
    emitToUsers(added, "conversationAdded", { conversationId: ctx.channel.id, workspaceId: ws.id });
    await notifications.notify(added, { type: "channel_added", title: `${req.user.username} added you to #${ctx.channel.title}`, data: { conversationId: ctx.channel.id, workspaceId: ws.id }, actorId: req.user._id, dedupeKey: `channel_added:${ctx.channel.id}` });
  }
  res.json({ success: true, added });
});

const removeChannelMember = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const ctx = await channelAccess(req, res, ws);
  if (!ctx) return;
  if (!ctx.canManage) return fail(res, 403, "Only channel admins can remove members.");
  if (ctx.channel.channel_kind === "general") return fail(res, 400, "Members can't be removed from #general.");
  if (await Conversation.removeMember(ctx.channel.id, req.params.userId)) {
    emitToUsers([req.params.userId], "conversationRemoved", { conversationId: ctx.channel.id });
    await emitToConversation(ctx.channel.id, "conversationUpdated", { conversationId: ctx.channel.id });
  }
  res.json({ success: true });
});

/** PATCH /api/workspaces/:id/channels/:channelId { name?, description?, visibility?, adminsOnlyPost? } */
const updateChannel = handle(async (req, res) => {
  const ws = await access(req, res);
  if (!ws) return;
  const ctx = await channelAccess(req, res, ws);
  if (!ctx) return;
  if (!ctx.canManage) return fail(res, 403, "Only channel admins can change this channel.");
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) {
    if (ctx.channel.channel_kind === "general") return fail(res, 400, "#general can't be renamed.");
    fields.title = Workspace.channelName(b.name);
    if (!fields.title) return fail(res, 400, "Invalid channel name.");
    if (await Workspace.channelExists(ws.id, fields.title, ctx.channel.id)) return fail(res, 409, `#${fields.title} already exists.`);
  }
  if (b.description !== undefined) fields.description = b.description ? String(b.description).slice(0, 500) : null;
  if (["public", "private"].includes(b.visibility) && ctx.channel.channel_kind !== "general") fields.visibility = b.visibility;
  if (typeof b.adminsOnlyPost === "boolean") fields.adminsOnlyPost = b.adminsOnlyPost;
  await Conversation.update(ctx.channel.id, fields);
  await audit(req, "channel.update", { targetType: "channel", targetId: ctx.channel.id, workspaceId: ws.id, metadata: { fields: Object.keys(fields) } });
  await emitToConversation(ctx.channel.id, "conversationUpdated", { conversationId: ctx.channel.id });
  res.json({ success: true, conversation: await Conversation.getFull(ctx.channel.id, req.user._id) });
});

/** DELETE /api/workspaces/:id/channels/:channelId — workspace admins; never #general. */
const deleteChannel = handle(async (req, res) => {
  const ws = await access(req, res, "workspace.update");
  if (!ws) return;
  const channel = await Workspace.getChannel(ws.id, req.params.channelId);
  if (!channel) return fail(res, 404, "Channel not found.");
  if (channel.channel_kind === "general") return fail(res, 400, "#general can't be deleted.");
  const members = await Conversation.memberIds(channel.id);
  await require("../config/db").query("DELETE FROM conversations WHERE id = $1", [channel.id]);
  await audit(req, "channel.delete", { targetType: "channel", targetId: channel.id, workspaceId: ws.id, metadata: { name: channel.title } });
  emitToUsers(members, "conversationRemoved", { conversationId: channel.id });
  res.json({ success: true });
});

/** GET /api/workspaces/:id/activity — audit trail (admins). */
const getActivity = handle(async (req, res) => {
  const ws = await access(req, res, "audit.view");
  if (!ws) return;
  res.json({ success: true, events: await Workspace.activity(ws.id, { limit: req.query.limit, before: req.query.before || null }) });
});

module.exports = {
  listOrganizations,
  updateOrganization,
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  transferOwnership,
  listMembers,
  updateMember,
  removeMember,
  inviteMembers,
  listInvitations,
  revokeInvitation,
  previewInvitation,
  acceptInvitation,
  myInvitations,
  acceptInvitationById,
  listChannels,
  createChannel,
  joinChannel,
  leaveChannel,
  addChannelMembers,
  removeChannelMember,
  updateChannel,
  deleteChannel,
  getActivity,
};
