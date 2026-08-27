// The shape-convention contract: node shapes are written as the unified
// "discourse-node" type (node type id in props.nodeTypeId), and the
// loadability gate refuses stores the current Roam client would reject.
// Background: a legacy-typed node shape written into a discourse-schema-v5
// snapshot fails the client's validation and makes the canvas unopenable.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createNodeShapeRecord,
  createRelationRecords,
  shapeNodeTypeId,
} from "../src/canvas/records.js";
import {
  assertRecordsLoadable,
  findUnloadableRecords,
  DISCOURSE_SEQUENCE_ID,
} from "../src/canvas/schema.js";
import { buildBootstrapSnapshot } from "../src/canvas/write.js";
import type {
  CanvasContext,
  SerializedSchema,
  SerializedStore,
  TldrawRecord,
} from "../src/canvas/model.js";

const ctx: CanvasContext = {
  nodes: {
    "_EVD-node": { id: "_EVD-node", text: "Evidence", format: "[[EVD]] - {content}", shortcut: "E" },
    "_CLM-node": { id: "_CLM-node", text: "Claim", format: "[[CLM]] - {content}", shortcut: "C" },
  },
  relations: {
    rel1: { id: "rel1", label: "Supports", source: "_EVD-node", destination: "_CLM-node" },
  },
  canvasPageFormat: "Canvas/*",
};

const evd = ctx.nodes["_EVD-node"]!;

const schemaAt = (discourseVersion: number, extra: Record<string, number> = {}): SerializedSchema => ({
  schemaVersion: 2,
  sequences: { [DISCOURSE_SEQUENCE_ID]: discourseVersion, ...extra },
});

const nodeShape = (overrides: Partial<TldrawRecord>): TldrawRecord => ({
  id: "shape:n1",
  typeName: "shape",
  type: "discourse-node",
  parentId: "page:page",
  index: "a1",
  x: 0,
  y: 0,
  props: { w: 400, h: 102, uid: "abc123def", title: "[[EVD]] - x", nodeTypeId: "_EVD-node" },
  ...overrides,
});

test("createNodeShapeRecord writes the modern convention", () => {
  const shape = createNodeShapeRecord({
    nodeType: evd,
    uid: "abc123def",
    title: "[[EVD]] - a finding",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
  });
  assert.equal(shape.type, "discourse-node");
  const props = shape.props as { nodeTypeId?: string; imageUrl?: string };
  assert.equal(props.nodeTypeId, "_EVD-node");
  assert.equal(props.imageUrl, "");
});

test("shapeNodeTypeId reads both conventions", () => {
  assert.equal(shapeNodeTypeId(nodeShape({})), "_EVD-node");
  const legacy = nodeShape({ type: "_EVD-node", props: { uid: "u", title: "t" } });
  assert.equal(shapeNodeTypeId(legacy), "_EVD-node");
});

test("legacy node shape in a v5 snapshot is unloadable; in v3/v4 it is fine", () => {
  const legacy = nodeShape({ type: "_EVD-node", props: { uid: "u", title: "t" } });
  const store: SerializedStore = { [legacy.id]: legacy };
  assert.equal(findUnloadableRecords(store, schemaAt(5), ctx).length, 1);
  assert.match(findUnloadableRecords(store, schemaAt(5), ctx)[0]!, /_EVD-node/);
  assert.equal(findUnloadableRecords(store, schemaAt(4), ctx).length, 0);
  assert.equal(findUnloadableRecords(store, schemaAt(3), ctx).length, 0);
  assert.throws(() => assertRecordsLoadable(store, schemaAt(5), ctx), /Refusing to write/);
});

test("modern node, relation arrow + bindings, and builtins all load", () => {
  const node = nodeShape({});
  const [arrow, b1, b2] = createRelationRecords({
    relation: ctx.relations.rel1!,
    fromShape: node,
    toShape: nodeShape({ id: "shape:n2" }),
    parentId: "page:page",
    index: "a2",
  });
  const text: TldrawRecord = { id: "shape:t", typeName: "shape", type: "text", props: {} };
  const store: SerializedStore = Object.fromEntries(
    [node, arrow!, b1!, b2!, text].map((r) => [r.id, r]),
  );
  assert.deepEqual(findUnloadableRecords(store, schemaAt(5), ctx), []);
});

test("unknown type is rejected unless the canvas schema declares it", () => {
  const stranger = nodeShape({ id: "shape:s", type: "some-other-plugin", props: {} });
  const store: SerializedStore = { [stranger.id]: stranger };
  assert.equal(findUnloadableRecords(store, schemaAt(5), ctx).length, 1);
  const declaring = schemaAt(5, { "com.tldraw.shape.some-other-plugin": 0 });
  assert.equal(findUnloadableRecords(store, declaring, ctx).length, 0);
});

test("bootstrap schema mirrors a current client save", () => {
  const { schema } = buildBootstrapSnapshot(ctx);
  assert.equal(schema.sequences[DISCOURSE_SEQUENCE_ID], 5);
  assert.equal(schema.sequences["com.tldraw.shape.discourse-node"], 0);
  assert.equal(schema.sequences["com.tldraw.shape.rel1"], 0);
  assert.equal(schema.sequences["com.tldraw.binding.rel1"], 0);
  // No per-node-type, page-node, or blck-node sequences since discourse v5.
  assert.equal(schema.sequences["com.tldraw.shape._EVD-node"], undefined);
  assert.equal(schema.sequences["com.tldraw.shape.page-node"], undefined);
  assert.equal(schema.sequences["com.tldraw.shape.blck-node"], undefined);
});
