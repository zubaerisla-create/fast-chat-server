const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const h = require("./helpers");
const { initializeSocket } = require("../sockets/socketHandler");

let httpServer;
let url;
let alice, bob, eve, conversationId, aliceMessageId, eveMessageId;
const sockets = [];

test.before(async () => {
  httpServer = http.createServer();
  initializeSocket(new Server(httpServer));
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://127.0.0.1:${httpServer.address().port}`;

  await h.resetDb();
  alice = await h.createUser("alice");
  bob = await h.createUser("bob");
  eve = await h.createUser("eve");
  conversationId = await h.directConversation(alice.id, bob.id);
  aliceMessageId = (await h.query("INSERT INTO messages (conversation_id, sender_id, text) VALUES ($1, $2, 'hello bob') RETURNING id", [conversationId, alice.id])).rows[0].id;
  const eveConv = await h.directConversation(eve.id, bob.id);
  eveMessageId = (await h.query("INSERT INTO messages (conversation_id, sender_id, text) VALUES ($1, $2, 'from eve') RETURNING id", [eveConv, eve.id])).rows[0].id;
});

test.after(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => httpServer.close(r));
  await h.pool.end();
});

const open = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(url, { auth: token ? { token } : {}, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });

const online = async (s, claimedId) => {
  s.emit("userOnline", claimedId);
  await new Promise((r) => setTimeout(r, 150));
};

const received = (s, ms = 400) =>
  new Promise((resolve) => {
    const got = [];
    s.on("receiveMessage", (m) => got.push(m));
    setTimeout(() => resolve(got), ms);
  });

test("connections without a valid token are refused", async () => {
  await assert.rejects(open(null), /Authentication required/);
  await assert.rejects(open("not-a-jwt"), /Invalid token/);
});

test("a socket can't impersonate another user by claiming their ID", async () => {
  const bobSocket = await open(bob.token);
  await online(bobSocket, bob.id);
  const eveSocket = await open(eve.token);
  await online(eveSocket, bob.id); // claims to be Bob; the server uses Eve's verified ID

  const bobInbox = received(bobSocket);
  // Eve forges a message "from Alice" with arbitrary content
  eveSocket.emit("sendMessage", { receiverId: bob.id, message: { _id: aliceMessageId, text: "forged", senderId: { _id: alice.id } } });
  eveSocket.emit("sendMessage", { receiverId: bob.id, message: { text: "no id, made up" } });
  assert.deepEqual(await bobInbox, []);
});

test("only a stored message from the verified sender to a participant is relayed, as stored", async () => {
  const bobSocket = await open(bob.token);
  await online(bobSocket, bob.id);
  const aliceSocket = await open(alice.token);
  await online(aliceSocket, alice.id);

  const inbox = received(bobSocket);
  aliceSocket.emit("sendMessage", { receiverId: bob.id, message: { _id: aliceMessageId, text: "tampered text" } });
  aliceSocket.emit("send_message", { receiverId: eve.id, message: { _id: aliceMessageId } }); // Eve isn't in this conversation
  aliceSocket.emit("sendMessage", { receiverId: bob.id, message: { _id: eveMessageId } }); // not Alice's message
  const got = await inbox;
  assert.equal(got.length, 1);
  assert.equal(got[0].message.text, "hello bob", "the database copy is sent, not the client's");
});
