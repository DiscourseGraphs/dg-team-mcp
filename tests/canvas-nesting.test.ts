// Nested sub-canvas portals + the content primitives that recapitulating a
// real board needs (MCP-PORT-PLAN.md in dg-prototypes/nested-pages).
//
// The portal contract matches the Roam plugin PR (DiscourseGraphs/discourse-graph#1308)
// and its nestedPagesCompat.test.ts: a portal is a NATIVE geo rectangle with
// meta.dgSubpage, hierarchy lives in page.meta.dgNested, and there is no custom
// shape type — so every record here must pass BOTH full tldraw 2.4.6 validation
// and the current-client loadability gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createArrowShapeRecord,
  createGeoShapeRecord,
  createImageRecords,
  nextIndex,
  shapePageId,
} from "../src/canvas/records.js";
import {
  MAX_TLDRAW_PAGES,
  assertPageCapacity,
  createPageRecord,
  dedupePageName,
  deletePage,
  getNestedPageMeta,
  getSubpageMeta,
  listSubpagePortals,
  moveShapesToPage,
  newPageId,
  portalLabel,
  syncPortalLabels,
} from "../src/canvas/nesting.js";
import { assertRecordsLoadable, validateStoreRecords } from "../src/canvas/schema.js";
import { summarizeCanvas } from "../src/canvas/snapshot.js";
import type {
  CanvasContext,
  CanvasPageState,
  SerializedSchema,
  SerializedStore,
  TldrawRecord,
} from "../src/canvas/model.js";

const ctx: CanvasContext = { nodes: {}, relations: {}, canvasPageFormat: "Canvas/*" };

const documentRecord = (): TldrawRecord => ({
  gridSize: 10,
  name: "",
  meta: {},
  id: "document:document",
  typeName: "document",
});

const page = (id: string, name: string, index: string, meta: TldrawRecord["meta"] = {}) =>
  ({ id, typeName: "page", name, index, meta }) as TldrawRecord;

const baseStore = (): SerializedStore => ({
  "document:document": documentRecord(),
  "page:page": page("page:page", "Page 1", "a1"),
});

// The schema an old (feature-less) client effectively reasons against: builtin
// sequences only. Loadability of portal records must not depend on anything else.
const minimalSchema: SerializedSchema = { schemaVersion: 2, sequences: {} };

const makePortal = (store: SerializedStore, targetPageId: string, parentId = "page:page") =>
  createGeoShapeRecord({
    geo: "rectangle",
    text: portalLabel("Child"),
    x: 100,
    y: 100,
    w: 460,
    h: 340,
    color: "violet",
    fill: "semi",
    parentId,
    index: nextIndex(store),
    meta: { dgSubpage: { targetPageId, accent: "#6d5ae0", title: "Child" } },
  });

// ── page records ────────────────────────────────────────────────────────────

test("createPageRecord validates and lands after existing pages in board order", () => {
  const store = baseStore();
  const record = createPageRecord({
    store,
    name: "Child",
    meta: { dgNested: { parentPageId: "page:page" } },
  });
  store[record.id] = record;
  validateStoreRecords(store, ctx);
  assert.equal(record.typeName, "page");
  assert.ok(record.id.startsWith("page:"));
  assert.ok(String(record.index) > "a1");
});

test("dedupePageName appends a counter for colliding names", () => {
  const store = baseStore();
  assert.equal(dedupePageName(store, "Fresh"), "Fresh");
  assert.equal(dedupePageName(store, "Page 1"), "Page 1 2");
  store["page:b"] = page("page:b", "Page 1 2", "a2");
  assert.equal(dedupePageName(store, "Page 1"), "Page 1 3");
});

test("assertPageCapacity throws at the tldraw page cap", () => {
  const store = baseStore();
  for (let i = 2; i <= MAX_TLDRAW_PAGES; i += 1) {
    store[`page:p${i}`] = page(`page:p${i}`, `P${i}`, `a${i}`);
  }
  assert.throws(() => assertPageCapacity(store), /40/);
});

// ── portal contract ─────────────────────────────────────────────────────────

test("portal records pass full validation and old-client loadability", () => {
  const store = baseStore();
  const childId = newPageId();
  store[childId] = page(childId, "Child", "a2", {
    dgNested: { parentPageId: "page:page" },
  });
  const portal = makePortal(store, childId);
  store[portal.id] = portal;
  validateStoreRecords(store, ctx);
  // An old client registers no discourse types at all and its schema declares
  // no custom sequences; geo + meta must still load.
  assertRecordsLoadable(store, minimalSchema, ctx);
});

test("getSubpageMeta requires a string targetPageId", () => {
  const store = baseStore();
  const portal = makePortal(store, "page:child");
  assert.deepEqual(getSubpageMeta(portal)?.targetPageId, "page:child");
  assert.equal(getSubpageMeta(page("page:x", "X", "a9")), null);
  const broken = { ...portal, meta: { dgSubpage: { title: "no target" } } };
  assert.equal(getSubpageMeta(broken as TldrawRecord), null);
});

test("getNestedPageMeta reads the page lineage pointer", () => {
  const child = page("page:c", "C", "a2", { dgNested: { parentPageId: "page:page" } });
  assert.equal(getNestedPageMeta(child)?.parentPageId, "page:page");
  assert.equal(getNestedPageMeta(page("page:r", "R", "a1")), null);
});

test("portalLabel is the old-client visible label", () => {
  assert.equal(portalLabel("My Page"), "⤵ My Page");
});

// ── rename re-sync ──────────────────────────────────────────────────────────

test("syncPortalLabels rewrites label and stored title of portals targeting the page", () => {
  const store = baseStore();
  const portal = makePortal(store, "page:child");
  store[portal.id] = portal;
  const other = makePortal(store, "page:other");
  store[other.id] = other;
  const changed = syncPortalLabels(store, "page:child", "Renamed");
  assert.equal(changed, 1);
  const props = store[portal.id]!.props as { text?: string };
  assert.equal(props.text, portalLabel("Renamed"));
  assert.equal(getSubpageMeta(store[portal.id]!)?.title, "Renamed");
  assert.equal((store[other.id]!.props as { text?: string }).text, portalLabel("Child"));
});

// ── page delete ─────────────────────────────────────────────────────────────

test("deletePage removes the page and its contents, reports orphaned portals, keeps them", () => {
  const store = baseStore();
  const childId = "page:child";
  store[childId] = page(childId, "Child", "a2");
  const onChild = createGeoShapeRecord({
    geo: "rectangle",
    x: 0,
    y: 0,
    w: 50,
    h: 50,
    parentId: childId,
    index: nextIndex(store),
  });
  store[onChild.id] = onChild;
  const portal = makePortal(store, childId); // lives on page:page, points at child
  store[portal.id] = portal;

  const result = deletePage(store, childId);
  assert.equal(store[childId], undefined);
  assert.equal(store[onChild.id], undefined);
  assert.ok(result.removed.includes(onChild.id));
  assert.deepEqual(result.orphanedPortals, [portal.id]);
  assert.ok(store[portal.id], "the portal itself is never cascaded");
  validateStoreRecords(store, ctx);
});

test("deletePage refuses to delete the last page", () => {
  const store = baseStore();
  assert.throws(() => deletePage(store, "page:page"), /last/i);
});

// ── move between pages ──────────────────────────────────────────────────────

const boundArrowFixture = () => {
  const store = baseStore();
  store["page:b"] = page("page:b", "Other", "a2");
  const a = createGeoShapeRecord({
    geo: "rectangle", x: 0, y: 0, w: 40, h: 40,
    parentId: "page:page", index: nextIndex(store),
  });
  store[a.id] = a;
  const b = createGeoShapeRecord({
    geo: "rectangle", x: 200, y: 0, w: 40, h: 40,
    parentId: "page:page", index: nextIndex(store),
  });
  store[b.id] = b;
  const arrow = createArrowShapeRecord({
    start: { x: 20, y: 20 }, end: { x: 220, y: 20 },
    parentId: "page:page", index: nextIndex(store),
  });
  store[arrow.id] = arrow;
  store["binding:s"] = {
    id: "binding:s", typeName: "binding", type: "arrow", fromId: arrow.id, toId: a.id,
    props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    meta: {},
  } as TldrawRecord;
  store["binding:e"] = {
    id: "binding:e", typeName: "binding", type: "arrow", fromId: arrow.id, toId: b.id,
    props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    meta: {},
  } as TldrawRecord;
  return { store, a, b, arrow };
};

test("moveShapesToPage re-parents shapes and brings arrows whose endpoints all move", () => {
  const { store, a, b, arrow } = boundArrowFixture();
  const result = moveShapesToPage(store, [a.id, b.id], "page:b");
  assert.equal(shapePageId(store, a.id), "page:b");
  assert.equal(shapePageId(store, b.id), "page:b");
  assert.equal(shapePageId(store, arrow.id), "page:b", "bound arrow follows its endpoints");
  assert.equal(result.moved, 2);
  assert.equal(result.arrowsMoved, 1);
  validateStoreRecords(store, ctx);
});

test("moveShapesToPage refuses a move that would split a bound arrow across pages", () => {
  const { store, a } = boundArrowFixture();
  assert.throws(() => moveShapesToPage(store, [a.id], "page:b"), /arrow/i);
});

test("moveShapesToPage moves a frame with its children intact", () => {
  const store = baseStore();
  store["page:b"] = page("page:b", "Other", "a2");
  store["shape:frame1"] = {
    id: "shape:frame1", typeName: "shape", type: "frame", parentId: "page:page",
    index: "a1", x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 300, h: 200, name: "F" },
  } as TldrawRecord;
  const child = createGeoShapeRecord({
    geo: "rectangle", x: 5, y: 5, w: 20, h: 20,
    parentId: "shape:frame1", index: "a2",
  });
  store[child.id] = child;
  moveShapesToPage(store, ["shape:frame1"], "page:b");
  assert.equal(shapePageId(store, "shape:frame1"), "page:b");
  assert.equal(shapePageId(store, child.id), "page:b");
  assert.equal(store[child.id]!.parentId, "shape:frame1", "child stays frame-local");
});

test("moveShapesToPage pops a frame-child out with absolute coordinates when its frame stays", () => {
  const store = baseStore();
  store["page:b"] = page("page:b", "Other", "a2");
  store["shape:frame1"] = {
    id: "shape:frame1", typeName: "shape", type: "frame", parentId: "page:page",
    index: "a1", x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 300, h: 200, name: "F" },
  } as TldrawRecord;
  const child = createGeoShapeRecord({
    geo: "rectangle", x: 5, y: 7, w: 20, h: 20,
    parentId: "shape:frame1", index: "a2",
  });
  store[child.id] = child;
  moveShapesToPage(store, [child.id], "page:b");
  assert.equal(store[child.id]!.parentId, "page:b");
  assert.equal(store[child.id]!.x, 15, "absolute x preserved");
  assert.equal(store[child.id]!.y, 27, "absolute y preserved");
  assert.equal(shapePageId(store, "shape:frame1"), "page:page", "frame stays put");
});

// ── content primitives ──────────────────────────────────────────────────────

test("geo, arrow, and image records pass full validation and loadability", () => {
  const store = baseStore();
  const geo = createGeoShapeRecord({
    geo: "ellipse", text: "claim", x: 0, y: 0, w: 120, h: 80,
    color: "blue", fill: "solid", parentId: "page:page", index: nextIndex(store),
  });
  store[geo.id] = geo;
  const arrow = createArrowShapeRecord({
    start: { x: 10, y: 10 }, end: { x: 200, y: 90 }, text: "so",
    parentId: "page:page", index: nextIndex(store),
  });
  store[arrow.id] = arrow;
  const { asset, shape: image } = createImageRecords({
    src: "https://example.com/fig.png", name: "fig.png",
    x: 300, y: 0, w: 320, h: 240,
    parentId: "page:page", index: nextIndex(store),
  });
  store[asset.id] = asset;
  store[image.id] = image;
  validateStoreRecords(store, ctx);
  assertRecordsLoadable(store, minimalSchema, ctx);
  assert.equal((image.props as { assetId?: string }).assetId, asset.id);
});

test("arrow author stores endpoints relative to the shape origin", () => {
  const arrow = createArrowShapeRecord({
    start: { x: 50, y: 60 }, end: { x: 150, y: 100 },
    parentId: "page:page", index: "a1",
  });
  assert.equal(arrow.x, 50);
  assert.equal(arrow.y, 60);
  const props = arrow.props as { start: { x: number; y: number }; end: { x: number; y: number } };
  assert.deepEqual(props.start, { x: 0, y: 0 });
  assert.deepEqual(props.end, { x: 100, y: 40 });
});

// ── read side ───────────────────────────────────────────────────────────────

const summarize = (store: SerializedStore) =>
  summarizeCanvas(
    {
      pageUid: "uid", title: "Canvas/T", format: "snapshot",
      store, schema: { schemaVersion: 2, sequences: {} },
      stateId: null, allProps: {}, rjsqbSiblings: {},
    } as CanvasPageState,
    ctx,
  );

test("summarizeCanvas surfaces portals, geos, and plain arrows as first-class lists", () => {
  const store = baseStore();
  const childId = "page:child";
  store[childId] = page(childId, "Child", "a2", {
    dgNested: { parentPageId: "page:page" },
  });
  const portal = makePortal(store, childId);
  store[portal.id] = portal;
  const geo = createGeoShapeRecord({
    geo: "rectangle", text: "box", x: 0, y: 0, w: 50, h: 50,
    parentId: childId, index: nextIndex(store),
  });
  store[geo.id] = geo;
  const arrow = createArrowShapeRecord({
    start: { x: 0, y: 0 }, end: { x: 10, y: 10 },
    parentId: "page:page", index: nextIndex(store),
  });
  store[arrow.id] = arrow;

  const summary = summarize(store);
  assert.equal(summary.subpages?.length, 1);
  assert.deepEqual(summary.subpages?.[0], {
    shapeId: portal.id,
    targetPageId: childId,
    targetPageName: "Child",
    title: "Child",
    x: 100, y: 100, w: 460, h: 340,
    frame: undefined,
    page: "Page 1",
  });
  assert.equal(summary.geos?.[0]?.text, "box");
  assert.equal(summary.arrows?.length, 1);
  assert.equal(summary.otherShapes.length, 0, "nothing new falls into otherShapes");
  const childEntry = summary.pages.find((p) => p.id === childId);
  assert.equal(childEntry?.parentPageId, "page:page");
});

test("listSubpagePortals finds portals wherever they live", () => {
  const store = baseStore();
  store["page:b"] = page("page:b", "B", "a2");
  const portal = makePortal(store, "page:b", "page:b");
  store[portal.id] = portal;
  const found = listSubpagePortals(store);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.targetPageId, "page:b");
});
