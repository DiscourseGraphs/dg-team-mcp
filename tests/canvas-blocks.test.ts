// canvas_add_block's record layer: block shapes are written under the unified
// convention (shape.type "discourse-node", nodeTypeId "blck-node") so the v5
// client loads them, and reads split blocks out of `nodes` into `blocks`
// under either convention (legacy blck-node shapes still exist on old boards).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBlockShapeRecord, estimateBlockSize } from "../src/canvas/records.js";
import { findUnloadableRecords, DISCOURSE_SEQUENCE_ID } from "../src/canvas/schema.js";
import { summarizeCanvas } from "../src/canvas/snapshot.js";
import type {
  CanvasContext,
  CanvasPageState,
  SerializedSchema,
  SerializedStore,
  TldrawRecord,
} from "../src/canvas/model.js";

const ctx: CanvasContext = { nodes: {}, relations: {}, canvasPageFormat: "Canvas/*" };

const page = (id: string, name: string, index: string): TldrawRecord =>
  ({ id, typeName: "page", name, index, meta: {} }) as TldrawRecord;

test("createBlockShapeRecord writes the modern convention with nodeTypeId blck-node", () => {
  const shape = createBlockShapeRecord({
    uid: "d8qYnpl_H",
    text: "a block of text",
    x: 10,
    y: 20,
    parentId: "page:page",
    index: "a2",
  });
  assert.equal(shape.typeName, "shape");
  assert.equal(shape.type, "discourse-node");
  assert.equal(shape.parentId, "page:page");
  assert.equal(shape.index, "a2");
  assert.equal(shape.x, 10);
  assert.equal(shape.y, 20);
  const props = shape.props as Record<string, unknown>;
  // exact same key set as node shapes — validators and the live client are strict
  assert.deepEqual(Object.keys(props).sort(), [
    "fontFamily",
    "h",
    "imageUrl",
    "nodeTypeId",
    "size",
    "title",
    "uid",
    "w",
  ]);
  assert.equal(props.uid, "d8qYnpl_H");
  assert.equal(props.title, "a block of text");
  assert.equal(props.nodeTypeId, "blck-node");
});

test("created block shape loads in a v5 snapshot", () => {
  const shape = createBlockShapeRecord({
    uid: "d8qYnpl_H",
    text: "a block of text",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
  });
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    [shape.id]: shape,
  };
  const schema: SerializedSchema = {
    schemaVersion: 2,
    sequences: { [DISCOURSE_SEQUENCE_ID]: 5 },
  };
  assert.deepEqual(findUnloadableRecords(store, schema, ctx), []);
});

test("estimateBlockSize uses block width and grows with text", () => {
  const short = estimateBlockSize("short");
  const long = estimateBlockSize("x".repeat(1000));
  assert.equal(short.w, 400);
  assert.ok(long.h > short.h);
  assert.ok(long.h <= 400, `h clamped, got ${long.h}`);
});

const legacyBlockShape = (
  id: string,
  parentId: string,
  uid: string,
  title: string,
): TldrawRecord =>
  ({
    id,
    typeName: "shape",
    type: "blck-node",
    parentId,
    index: "a1",
    x: 5,
    y: 6,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 400, h: 100, uid, title, imageUrl: "", size: "s", fontFamily: "sans" },
  }) as TldrawRecord;

const state = (store: SerializedStore): CanvasPageState => ({
  pageUid: "canvasuid1",
  title: "Canvas/Test",
  format: "snapshot",
  store,
  schema: { schemaVersion: 2, sequences: {} },
  stateId: null,
  allProps: {},
  rjsqbSiblings: {},
});

test("summarizeCanvas splits blocks from nodes", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:blk": legacyBlockShape("shape:blk", "page:page", "blockuid1", "the block text"),
    "shape:node": {
      id: "shape:node",
      typeName: "shape",
      type: "sometypeid",
      parentId: "page:page",
      index: "a2",
      x: 1,
      y: 2,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        w: 200,
        h: 60,
        uid: "pageuid11",
        title: "[[EVD]] - x",
        imageUrl: "",
        size: "s",
        fontFamily: "sans",
      },
    } as TldrawRecord,
  };
  const summary = summarizeCanvas(state(store), ctx);
  assert.equal(summary.blocks.length, 1);
  assert.equal(summary.blocks[0]!.blockUid, "blockuid1");
  assert.equal(summary.blocks[0]!.text, "the block text");
  assert.equal(summary.nodes.length, 1);
  assert.equal(summary.nodes[0]!.uid, "pageuid11");
  // single-page canvas: no per-item page annotations
  assert.equal(summary.blocks[0]!.page, undefined);
  assert.equal(summary.nodes[0]!.page, undefined);
});

test("summarizeCanvas annotates blocks with page names on multi-page canvases", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Abstract", "a1"),
    "page:b": page("page:b", "With OXA", "a2"),
    "shape:blk1": legacyBlockShape("shape:blk1", "page:page", "u1", "on abstract"),
    "shape:blk2": legacyBlockShape("shape:blk2", "page:b", "u2", "on oxa"),
  };
  const summary = summarizeCanvas(state(store), ctx);
  assert.equal(summary.pages.length, 2);
  const byUid = new Map(summary.blocks.map((b) => [b.blockUid, b.page]));
  assert.equal(byUid.get("u1"), "Abstract");
  assert.equal(byUid.get("u2"), "With OXA");
});

test("summarizeCanvas treats modern discourse-node shapes with nodeTypeId blck-node as blocks", () => {
  const modern = createBlockShapeRecord({
    uid: "mu1",
    text: "modern block",
    x: 0,
    y: 0,
    parentId: "page:page",
    index: "a1",
  });
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    [modern.id]: modern,
  };
  const summary = summarizeCanvas(state(store), ctx);
  assert.equal(summary.nodes.length, 0);
  assert.equal(summary.blocks.length, 1);
  assert.equal(summary.blocks[0]!.blockUid, "mu1");
  assert.equal(summary.blocks[0]!.text, "modern block");
});
