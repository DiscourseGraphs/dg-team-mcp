import { test } from "node:test";
import assert from "node:assert/strict";

import type { RoamClient } from "@roam-research/roam-tools-local";
import { nudgeOpenCanvasClients, isCanvasOpenInRoam } from "../src/canvas/write.js";

type Call = { action: string; args: unknown[] };

const fakeClient = (
  respond: (action: string, args: unknown[]) => unknown,
): { client: RoamClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client = {
    call: async (action: string, args: unknown[] = []) => {
      calls.push({ action, args });
      return { success: true, result: respond(action, args) };
    },
  } as unknown as RoamClient;
  return { client, calls };
};

test("nudgeOpenCanvasClients creates then deletes a throwaway block on the page", async () => {
  const { client, calls } = fakeClient((action) =>
    action === "data.block.fromMarkdown" ? { uids: ["tmpblock01"] } : undefined,
  );
  const nudged = await nudgeOpenCanvasClients(client, "pageuid123", { ingestDelayMs: 0 });
  assert.equal(nudged, true);
  assert.deepEqual(
    calls.map((c) => c.action),
    ["data.block.fromMarkdown", "data.block.delete"],
  );
  assert.deepEqual(calls[0]!.args[0], {
    location: { "parent-uid": "pageuid123", order: "last" },
    "markdown-string": "-",
  });
  assert.deepEqual(calls[1]!.args[0], { block: { uid: "tmpblock01" } });
});

test("nudgeOpenCanvasClients reports false (and skips delete) when create returns no uid", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const nudged = await nudgeOpenCanvasClients(client, "pageuid123", { ingestDelayMs: 0 });
  assert.equal(nudged, false);
  assert.deepEqual(
    calls.map((c) => c.action),
    ["data.block.fromMarkdown"],
  );
});

test("isCanvasOpenInRoam finds the page uid in main or sidebar views", async () => {
  const inSidebar = fakeClient((action) =>
    action === "ui.rightSidebar.getWindows"
      ? [{ type: "outline", "page-uid": "canvasuid1" }]
      : { uid: "otherpage9" },
  );
  assert.equal(await isCanvasOpenInRoam(inSidebar.client, "canvasuid1"), true);

  const inMain = fakeClient((action) =>
    action === "ui.mainWindow.getOpenView" ? { page: { uid: "canvasuid1" } } : [],
  );
  assert.equal(await isCanvasOpenInRoam(inMain.client, "canvasuid1"), true);

  const closed = fakeClient((action) =>
    action === "ui.mainWindow.getOpenView" ? { page: { uid: "otherpage9" } } : [],
  );
  assert.equal(await isCanvasOpenInRoam(closed.client, "canvasuid1"), false);
});

test("isCanvasOpenInRoam degrades to 'unknown' when the ui actions fail", async () => {
  const client = {
    call: async () => {
      throw new Error("unsupported action");
    },
  } as unknown as RoamClient;
  assert.equal(await isCanvasOpenInRoam(client, "canvasuid1"), "unknown");
});
