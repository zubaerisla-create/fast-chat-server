/**
 * Workspace role-based access control. One table of permissions → minimum role;
 * workspace settings may raise/lower a few of them (who may invite / create channels).
 *
 *   owner > admin > manager > member > guest
 *
 * Guests only see channels they were added to and can't invite or create anything.
 * Every workspace endpoint checks permissions here, server-side.
 */
const RANK = { guest: 0, member: 1, manager: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(RANK);

const PERMISSIONS = {
  "workspace.view": "guest",
  "workspace.update": "admin",
  "workspace.delete": "owner",
  "workspace.transfer": "owner",
  "members.view": "member",
  "members.invite": "manager", // overridable: settings.minInviteRole
  "members.remove": "admin",
  "members.role": "admin",
  "channels.browse": "member",
  "channels.create": "member", // overridable: settings.minChannelCreateRole
  "channels.manage": "manager",
  "tasks.create": "member",
  "tasks.manage": "manager",
  "audit.view": "admin",
};

const OVERRIDABLE = { "members.invite": "minInviteRole", "channels.create": "minChannelCreateRole" };

const atLeast = (role, minimum) => (RANK[role] ?? -1) >= RANK[minimum];

function can(role, permission, settings = {}) {
  const base = PERMISSIONS[permission];
  if (!base) throw new Error(`Unknown permission ${permission}`);
  const override = OVERRIDABLE[permission] && settings[OVERRIDABLE[permission]];
  // Overrides can't open an action to guests or lock out admins
  const min = override && RANK[override] >= RANK.member && RANK[override] <= RANK.admin ? override : base;
  return atLeast(role, min);
}

/** Actor may change/remove target only if strictly above them (owner can manage everyone else). */
const outranks = (actorRole, targetRole) => RANK[actorRole] > RANK[targetRole];

/** Roles an actor may assign: below their own (owner may assign admin). Ownership moves via transfer only. */
const assignableRoles = (actorRole) => ROLES.filter((r) => r !== "owner" && RANK[r] < RANK[actorRole]);

module.exports = { RANK, ROLES, PERMISSIONS, can, atLeast, outranks, assignableRoles };
