const express = require("express");
const w = require("../controllers/workspaceController");
const { protect } = require("../middleware/authMiddleware");

// /api/workspaces — every route requires sign-in; permissions are checked per workspace (services/rbac.js)
const workspaces = express.Router();
workspaces.use(protect);
workspaces.get("/", w.listWorkspaces);
workspaces.post("/", w.createWorkspace);
workspaces.get("/:id", w.getWorkspace);
workspaces.patch("/:id", w.updateWorkspace);
workspaces.delete("/:id", w.deleteWorkspace);
workspaces.post("/:id/transfer", w.transferOwnership);
workspaces.get("/:id/members", w.listMembers); // ?q=&limit=&offset=
workspaces.patch("/:id/members/:userId", w.updateMember);
workspaces.delete("/:id/members/:userId", w.removeMember); // own id = leave
workspaces.get("/:id/invitations", w.listInvitations);
workspaces.post("/:id/invitations", w.inviteMembers);
workspaces.delete("/:id/invitations/:invitationId", w.revokeInvitation);
workspaces.get("/:id/channels", w.listChannels);
workspaces.post("/:id/channels", w.createChannel);
workspaces.patch("/:id/channels/:channelId", w.updateChannel);
workspaces.delete("/:id/channels/:channelId", w.deleteChannel);
workspaces.post("/:id/channels/:channelId/join", w.joinChannel);
workspaces.post("/:id/channels/:channelId/leave", w.leaveChannel);
workspaces.post("/:id/channels/:channelId/members", w.addChannelMembers);
workspaces.delete("/:id/channels/:channelId/members/:userId", w.removeChannelMember);
workspaces.get("/:id/activity", w.getActivity);

// /api/organizations
const organizations = express.Router();
organizations.use(protect);
organizations.get("/", w.listOrganizations);
organizations.patch("/:orgId", w.updateOrganization);

// /api/invitations — the token preview is public so the invite page works before sign-in
const invitations = express.Router();
invitations.get("/", protect, w.myInvitations);
invitations.post("/id/:invitationId/accept", protect, w.acceptInvitationById);
invitations.get("/:token", w.previewInvitation);
invitations.post("/:token/accept", protect, w.acceptInvitation);

module.exports = { workspaces, organizations, invitations };
