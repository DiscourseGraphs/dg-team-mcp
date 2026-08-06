import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeProps } from "../src/canvas/props.js";
import { formatNodeTitle } from "../src/canvas/context.js";
import {
  expandDeletionSet,
  shapeAbsoluteOrigin,
  nextIndex,
  estimateNodeSize,
} from "../src/canvas/records.js";
import type { CanvasNodeType, SerializedStore, TldrawRecord } from "../src/canvas/model.js";

test("normalizeProps strips leading colons recursively, keeps values", () => {
  const raw = {
    ":roamjs-query-builder": {
      ":stateId": "abc",
      ":tldraw": { ":store": { ":shape:1": { ":x": 5 } } },
      ":list": [{ ":k": 1 }, "plain"],
    },
  };
  assert.deepEqual(normalizeProps(raw), {
    "roamjs-query-builder": {
      stateId: "abc",
      tldraw: { store: { "shape:1": { x: 5 } } },
      list: [{ k: 1 }, "plain"],
    },
  });
  // interior colons in record-id keys are preserved
  assert.deepEqual(normalizeProps({ ":shape:abc": 1 }), { "shape:abc": 1 });
});

test("formatNodeTitle substitutes {content} and drops other tokens", () => {
  const evd: CanvasNodeType = {
    id: "e",
    text: "Evidence",
    format: "[[EVD]] - {content} - {Source}",
    shortcut: "E",
  };
  assert.equal(formatNodeTitle(evd, "a finding"), "[[EVD]] - a finding");
  const clm: CanvasNodeType = { id: "c", text: "Claim", format: "[[CLM]] - {content}", shortcut: "C" };
  assert.equal(formatNodeTitle(clm, "a claim"), "[[CLM]] - a claim");
});

test("shapeAbsoluteOrigin resolves frame-local coords up the parent chain", () => {
  const store: SerializedStore = {
    "page:page": { id: "page:page", typeName: "page" } as TldrawRecord,
    "shape:frame": {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 1000,
      y: 200,
    } as TldrawRecord,
    "shape:node": {
      id: "shape:node",
      typeName: "shape",
      type: "geo",
      parentId: "shape:frame",
      x: 60,
      y: 80,
    } as TldrawRecord,
  };
  assert.deepEqual(shapeAbsoluteOrigin(store, "shape:node"), { x: 1060, y: 280 });
  assert.deepEqual(shapeAbsoluteOrigin(store, "shape:frame"), { x: 1000, y: 200 });
});

test("expandDeletionSet cascades a node to its arrow and both bindings", () => {
  const store: SerializedStore = {
    "shape:nodeA": { id: "shape:nodeA", typeName: "shape", type: "n" } as TldrawRecord,
    "shape:nodeB": { id: "shape:nodeB", typeName: "shape", type: "n" } as TldrawRecord,
    "shape:arrow": { id: "shape:arrow", typeName: "shape", type: "rel" } as TldrawRecord,
    "binding:s": {
      id: "binding:s",
      typeName: "binding",
      fromId: "shape:arrow",
      toId: "shape:nodeA",
    } as TldrawRecord,
    "binding:e": {
      id: "binding:e",
      typeName: "binding",
      fromId: "shape:arrow",
      toId: "shape:nodeB",
    } as TldrawRecord,
  };
  const del = expandDeletionSet(store, ["shape:nodeA"]);
  assert.equal(del.size, 4);
  for (const id of ["shape:nodeA", "shape:arrow", "binding:s", "binding:e"]) {
    assert.ok(del.has(id), `expected ${id} in deletion set`);
  }
  // deleting the other bound node cascades the same arrow + bindings
  assert.equal(expandDeletionSet(store, ["shape:nodeB"]).size, 4);
});

test("nextIndex returns a key above the current max", () => {
  const store: SerializedStore = {
    a: { id: "a", typeName: "shape", index: "a1" } as TldrawRecord,
    b: { id: "b", typeName: "shape", index: "a2" } as TldrawRecord,
  };
  const idx = nextIndex(store);
  assert.ok(idx > "a2", `${idx} should sort after a2`);
});

test("estimateNodeSize clamps to sane bounds", () => {
  const small = estimateNodeSize("x");
  assert.ok(small.w >= 200 && small.w <= 380);
  const big = estimateNodeSize("x".repeat(500));
  assert.ok(big.w <= 380 && big.h <= 220);
});
