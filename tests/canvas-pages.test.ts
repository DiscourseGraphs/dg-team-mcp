// Multi-page targeting, text wrapping, and arrow re-pointing (the round-2
// fixes from live testing 2026-08-27). Page helpers are ported from the
// feat/canvas-blocks prototype branch.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTextShapeRecord,
  listPages,
  repointArrow,
  resolveTargetPage,
  shapePageId,
} from "../src/canvas/records.js";
import { summarizeCanvas } from "../src/canvas/snapshot.js";
import type {
  CanvasContext,
  CanvasPageState,
  SerializedStore,
  TldrawRecord,
} from "../src/canvas/model.js";

const page = (id: string, name: string, index: string): TldrawRecord =>
  ({ id, typeName: "page", name, index }) as TldrawRecord;

const ctx: CanvasContext = { nodes: {}, relations: {}, canvasPageFormat: "Canvas/*" };

test("listPages returns pages sorted by fractional index", () => {
  const store: SerializedStore = {
    "page:c": page("page:c", "Third", "a3"),
    "page:page": page("page:page", "First", "a1"),
    "page:b": page("page:b", "Second", "a2"),
  };
  assert.deepEqual(listPages(store), [
    { id: "page:page", name: "First", index: "a1" },
    { id: "page:b", name: "Second", index: "a2" },
    { id: "page:c", name: "Third", index: "a3" },
  ]);
});

test("resolveTargetPage defaults to the only page", () => {
  const store: SerializedStore = { "page:page": page("page:page", "Page 1", "a1") };
  assert.equal(resolveTargetPage(store, undefined), "page:page");
});

test("resolveTargetPage without ref on a multi-page canvas throws listing names", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Overview", "a1"),
    "page:b": page("page:b", "Parameters", "a2"),
  };
  assert.throws(
    () => resolveTargetPage(store, undefined),
    (e: Error) => e.message.includes("Overview") && e.message.includes("Parameters"),
  );
});

test("resolveTargetPage resolves by name (case-insensitive) and by record id", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Overview", "a1"),
    "page:b": page("page:b", "Parameters", "a2"),
  };
  assert.equal(resolveTargetPage(store, "parameters"), "page:b");
  assert.equal(resolveTargetPage(store, "page:b"), "page:b");
  assert.throws(() => resolveTargetPage(store, "nope"), /nope/);
});

test("shapePageId walks the parent chain through frames", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:frame": {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 0,
      y: 0,
    } as TldrawRecord,
    "shape:inner": {
      id: "shape:inner",
      typeName: "shape",
      type: "geo",
      parentId: "shape:frame",
      x: 0,
      y: 0,
    } as TldrawRecord,
  };
  assert.equal(shapePageId(store, "shape:inner"), "page:page");
  assert.equal(shapePageId(store, "shape:frame"), "page:page");
});

const nodeShape = (id: string, parentId: string, uid: string): TldrawRecord =>
  ({
    id,
    typeName: "shape",
    type: "discourse-node",
    parentId,
    index: "a1",
    x: 1,
    y: 2,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 400,
      h: 102,
      uid,
      title: "[[EVD]] - x",
      nodeTypeId: "_EVD-node",
      size: "s",
      fontFamily: "sans",
      imageUrl: "",
    },
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

test("summarizeCanvas lists pages and annotates items only on multi-page boards", () => {
  const single: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:n1": nodeShape("shape:n1", "page:page", "u1"),
  };
  const s1 = summarizeCanvas(state(single), ctx);
  assert.deepEqual(s1.pages, [{ id: "page:page", name: "Page 1", index: "a1" }]);
  assert.equal(s1.nodes[0]!.page, undefined);

  const multi: SerializedStore = {
    "page:page": page("page:page", "Overview", "a1"),
    "page:b": page("page:b", "Parameters", "a2"),
    "shape:n1": nodeShape("shape:n1", "page:page", "u1"),
    "shape:n2": nodeShape("shape:n2", "page:b", "u2"),
  };
  const s2 = summarizeCanvas(state(multi), ctx);
  assert.equal(s2.pages.length, 2);
  const byUid = new Map(s2.nodes.map((n) => [n.uid, n.page]));
  assert.equal(byUid.get("u1"), "Overview");
  assert.equal(byUid.get("u2"), "Parameters");
});

test("createTextShapeRecord: short labels stay autoSize, long labels wrap at 400", () => {
  const base = { x: 0, y: 0, parentId: "page:page", index: "a1" };
  const short = createTextShapeRecord({ ...base, text: "short label" });
  assert.equal((short.props as { autoSize?: boolean }).autoSize, true);
  const long = createTextShapeRecord({ ...base, text: "x".repeat(120) });
  const longProps = long.props as { autoSize?: boolean; w?: number };
  assert.equal(longProps.autoSize, false);
  assert.equal(longProps.w, 400);
  const custom = createTextShapeRecord({ ...base, text: "short label", width: 250 });
  const customProps = custom.props as { autoSize?: boolean; w?: number };
  assert.equal(customProps.autoSize, false);
  assert.equal(customProps.w, 250);
});

const arrow = (overrides: Partial<TldrawRecord> = {}): TldrawRecord =>
  ({
    id: "shape:a",
    typeName: "shape",
    type: "arrow",
    parentId: "page:page",
    index: "a1",
    x: 100,
    y: 100,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      start: { x: 0, y: 0 },
      end: { x: 50, y: 20 },
      bend: 7,
      text: "note",
    },
    ...overrides,
  }) as TldrawRecord;

test("repointArrow rewrites origin and endpoint vectors, keeping other props", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:a": arrow(),
  };
  repointArrow(store, "shape:a", { start: { x: 10, y: 20 }, end: { x: 110, y: 220 } });
  const a = store["shape:a"]!;
  assert.equal(a.x, 10);
  assert.equal(a.y, 20);
  const props = a.props as { start: { x: number; y: number }; end: { x: number; y: number }; bend: number };
  assert.deepEqual(props.start, { x: 0, y: 0 });
  assert.deepEqual(props.end, { x: 100, y: 200 });
  assert.equal(props.bend, 7);
});

test("repointArrow with only end keeps the absolute start where it was", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:a": arrow(),
  };
  // absolute start = (100,100), absolute end = (150,120)
  repointArrow(store, "shape:a", { end: { x: 300, y: 400 } });
  const a = store["shape:a"]!;
  assert.equal(a.x, 100);
  assert.equal(a.y, 100);
  assert.deepEqual((a.props as { end: unknown }).end, { x: 200, y: 300 });
});

test("repointArrow refuses a bound terminal and non-arrow shapes", () => {
  const store: SerializedStore = {
    "page:page": page("page:page", "Page 1", "a1"),
    "shape:a": arrow(),
    "shape:n": nodeShape("shape:n", "page:page", "u1"),
    "binding:e": {
      id: "binding:e",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:a",
      toId: "shape:n",
      props: { terminal: "end" },
    } as TldrawRecord,
  };
  assert.throws(() => repointArrow(store, "shape:a", { end: { x: 0, y: 0 } }), /bound to shape/);
  // the unbound start terminal is still re-pointable
  repointArrow(store, "shape:a", { start: { x: 5, y: 5 } });
  assert.throws(() => repointArrow(store, "shape:n", { end: { x: 0, y: 0 } }), /not an arrow/);
});
