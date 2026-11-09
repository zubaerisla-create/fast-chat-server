const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;
let alice, bob, carol;

test.before(async () => {
  srv = await h.startServer();
});

test.after(async () => {
  await srv.close();
  await h.pool.end();
});

test.beforeEach(async () => {
  await h.resetDb();
  alice = await h.createUser("alice_test");
  bob = await h.createUser("bob_test");
  carol = await h.createUser("carol_test");
});

test("exact username search only matches full exact username, case-insensitive", async () => {
  // Partial search fails
  const partial = await srv.call("GET", "/api/users/search/exact?username=alice", { token: bob.token });
  assert.equal(partial.status, 404);
  assert.equal(partial.body.message, "User not found.");

  // Exact search succeeds
  const exact = await srv.call("GET", "/api/users/search/exact?username=alice_test", { token: bob.token });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.user.username, "alice_test");
  assert.equal(exact.body.relationship, "none");

  // Case-insensitive exact search succeeds
  const caseInsensitive = await srv.call("GET", "/api/users/search/exact?username=ALICE_TEST", { token: bob.token });
  assert.equal(caseInsensitive.status, 200);
  assert.equal(caseInsensitive.body.user.username, "alice_test");

  // Searching for oneself returns 400
  const self = await srv.call("GET", "/api/users/search/exact?username=bob_test", { token: bob.token });
  assert.equal(self.status, 400);

  // Nonexistent user returns 404
  const none = await srv.call("GET", "/api/users/search/exact?username=nobody_here", { token: bob.token });
  assert.equal(none.status, 404);
});

test("friend request lifecycle: send, prevent duplicates, accept, and reject", async () => {
  // Alice sends request to Bob
  const sendRes = await srv.call("POST", "/api/friends/requests", {
    token: alice.token,
    body: { receiverId: bob.id },
  });
  assert.equal(sendRes.status, 201);
  const reqId = sendRes.body.request.id;
  assert.equal(sendRes.body.request.status, "pending");

  // Duplicate request from Alice is rejected
  const dupRes = await srv.call("POST", "/api/friends/requests", {
    token: alice.token,
    body: { receiverId: bob.id },
  });
  assert.equal(dupRes.status, 400);
  assert.match(dupRes.body.message, /already sent/i);

  // Bob sends to Alice while pending -> rejected
  const reverseRes = await srv.call("POST", "/api/friends/requests", {
    token: bob.token,
    body: { receiverId: alice.id },
  });
  assert.equal(reverseRes.status, 400);

  // Check incoming for Bob
  const bobRequests = await srv.call("GET", "/api/friends/requests", { token: bob.token });
  assert.equal(bobRequests.status, 200);
  assert.equal(bobRequests.body.incoming.length, 1);
  assert.equal(bobRequests.body.incoming[0].id, reqId);
  assert.equal(bobRequests.body.incoming[0].sender.username, "alice_test");

  // Check outgoing for Alice
  const aliceRequests = await srv.call("GET", "/api/friends/requests", { token: alice.token });
  assert.equal(aliceRequests.status, 200);
  assert.equal(aliceRequests.body.outgoing.length, 1);
  assert.equal(aliceRequests.body.outgoing[0].id, reqId);
  assert.equal(aliceRequests.body.outgoing[0].receiver.username, "bob_test");

  // Bob accepts the request
  const acceptRes = await srv.call("POST", `/api/friends/requests/${reqId}/accept`, { token: bob.token });
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.body.request.status, "accepted");
  assert.ok(acceptRes.body.conversation);

  // Now both can see each other in friends list
  const bobFriends = await srv.call("GET", "/api/friends", { token: bob.token });
  assert.equal(bobFriends.body.friends.length, 1);
  assert.equal(bobFriends.body.friends[0].username, "alice_test");

  // Relationship status is now 'accepted'
  const statusRes = await srv.call("GET", `/api/friends/status/${bob.id}`, { token: alice.token });
  assert.equal(statusRes.body.status, "accepted");
});

test("blocking prevents requests, hides from exact search, and unblocking does not restore messaging", async () => {
  // Alice blocks Bob
  const blockRes = await srv.call("POST", `/api/users/${bob.id}/block`, { token: alice.token });
  assert.equal(blockRes.status, 200);

  // Bob searching for Alice gets 404 User not found
  const searchRes = await srv.call("GET", "/api/users/search/exact?username=alice_test", { token: bob.token });
  assert.equal(searchRes.status, 404);

  // Bob cannot send friend request to Alice
  const reqRes = await srv.call("POST", "/api/friends/requests", { token: bob.token, body: { receiverId: alice.id } });
  assert.equal(reqRes.status, 403);

  // Alice checks blocked list
  const blockedList = await srv.call("GET", "/api/users/blocked", { token: alice.token });
  assert.equal(blockedList.status, 200);
  assert.ok(blockedList.body.users.some((u) => u.id === bob.id));

  // Alice unblocks Bob
  const unblockRes = await srv.call("POST", `/api/users/${bob.id}/unblock`, { token: alice.token });
  assert.equal(unblockRes.status, 200);

  // After unblocking, status must be 'none' (not accepted)
  const relAfter = await srv.call("GET", `/api/friends/status/${bob.id}`, { token: alice.token });
  assert.equal(relAfter.body.status, "none");
});
