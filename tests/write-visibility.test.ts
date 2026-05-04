import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  createWriteVisibilityService,
  WRITE_VISIBILITY_CLEAR_PATH,
  WRITE_VISIBILITY_CURRENT_PATH,
  WRITE_VISIBILITY_HEALTH_PATH,
} from "../src/write-visibility.js";
import {
  handleGetPendingWriteBatch,
  handleProposeWriteBatch,
} from "../src/tools/proposed-writes.js";

const silentLogger = {
  error: () => undefined,
};

const parseToolJson = (result: {
  content: Array<{ type: string; text?: string }>;
}) => JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;

const listenOnRandomPort = async (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || !address?.port) {
        reject(new Error("Server did not receive a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });

const closeServer = async (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

test("a non-owner MCP session forwards proposed writes to the bridge owner", async (t) => {
  const owner = createWriteVisibilityService({
    cwd: "/owner-cwd",
    instanceId: "owner-instance",
    logger: silentLogger,
    pid: 111,
    startedAt: "2026-05-04T00:00:00.000Z",
  });
  const ownerSnapshot = await owner.start({ port: 0 });
  t.after(() => owner.stop());

  const healthResponse = await fetch(
    `http://127.0.0.1:${ownerSnapshot.port}${WRITE_VISIBILITY_HEALTH_PATH}`,
  );
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json() as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal(health.role, "owner");
  assert.equal(health.pid, 111);
  assert.equal(health.cwd, "/owner-cwd");
  assert.equal(health.startedAt, "2026-05-04T00:00:00.000Z");
  assert.equal(health.pendingCount, 0);
  assert.equal(health.port, ownerSnapshot.port);

  const client = createWriteVisibilityService({
    cwd: "/client-cwd",
    instanceId: "client-instance",
    logger: silentLogger,
    pid: 222,
    startedAt: "2026-05-04T00:01:00.000Z",
  });
  const clientSnapshot = await client.start({ port: ownerSnapshot.port });
  t.after(() => client.stop());

  assert.equal(clientSnapshot.role, "client");
  assert.equal(clientSnapshot.owner?.pid, 111);

  const proposed = await handleProposeWriteBatch({
    graph: "test-graph",
    graphNickname: "Test Graph",
    parentUid: "parent-uid",
    writeVisibility: client,
    writes: [
      {
        label: "branch-a",
        markdown: "- Parent child\n  - Nested child",
      },
    ],
  });
  assert.equal(proposed.isError, undefined);

  const proposedPayload = parseToolJson(proposed);
  assert.equal(proposedPayload.status, "pending_in_roam");
  assert.equal(proposedPayload.storedVia, "forwarded_to_owner");
  assert.equal(proposedPayload.parentUid, "parent-uid");
  const batchId = proposedPayload.batchId;
  assert.equal(typeof batchId, "string");

  const currentResponse = await fetch(
    `http://127.0.0.1:${ownerSnapshot.port}${WRITE_VISIBILITY_CURRENT_PATH}`,
  );
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json() as {
    batches?: Array<{ batchId: string; parentUid: string }>;
  };
  assert.equal(current.batches?.length, 1);
  assert.equal(current.batches?.[0]?.batchId, batchId);
  assert.equal(current.batches?.[0]?.parentUid, "parent-uid");

  const pendingResult = await handleGetPendingWriteBatch({
    batchId: String(batchId),
    writeVisibility: client,
  });
  const pendingPayload = parseToolJson(pendingResult);
  assert.equal(pendingPayload.status, "pending_in_roam");

  const clearResponse = await fetch(
    `http://127.0.0.1:${ownerSnapshot.port}${WRITE_VISIBILITY_CLEAR_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, resolution: "approved" }),
    },
  );
  assert.equal(clearResponse.status, 200);

  const resolvedResult = await handleGetPendingWriteBatch({
    batchId: String(batchId),
    writeVisibility: client,
  });
  const resolvedPayload = parseToolJson(resolvedResult);
  assert.equal(resolvedPayload.status, "resolved");
  assert.equal(resolvedPayload.resolution, "approved");
  assert.equal(resolvedPayload.batchId, batchId);

  const emptyCurrentResponse = await fetch(
    `http://127.0.0.1:${ownerSnapshot.port}${WRITE_VISIBILITY_CURRENT_PATH}`,
  );
  assert.equal(emptyCurrentResponse.status, 204);
});

test("a non-owner returns a tool error when the port owner is not a valid bridge", async (t) => {
  const nonBridgeServer = createServer((request, response) => {
    if (request.url === WRITE_VISIBILITY_HEALTH_PATH) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "not-dg-team-mcp" }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  const port = await listenOnRandomPort(nonBridgeServer);
  t.after(() => closeServer(nonBridgeServer));

  const client = createWriteVisibilityService({
    cwd: "/client-cwd",
    instanceId: "invalid-client",
    logger: silentLogger,
    pid: 333,
  });
  const clientSnapshot = await client.start({ port });
  t.after(() => client.stop());

  assert.equal(clientSnapshot.role, "unavailable");
  assert.equal(
    clientSnapshot.unavailableReason,
    "port_occupied_by_non_bridge",
  );

  const proposed = await handleProposeWriteBatch({
    parentUid: "parent-uid",
    writeVisibility: client,
    writes: [{ markdown: "- Invisible write" }],
  });
  assert.equal(proposed.isError, true);

  const payload = parseToolJson(proposed);
  assert.equal(payload.status, "error");
  assert.equal(payload.error, "write_locator_bridge_unavailable");
  assert.equal(payload.reason, "port_occupied_by_non_bridge");
  assert.match(
    String(payload.attemptedUrl),
    /\/write-visibility\/propose$/,
  );
});
