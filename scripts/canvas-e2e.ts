// E2E for the canvas layer against a live graph via the Roam Local API.
// Roam Desktop must be running with the graph available.
// Run: npx tsx scripts/canvas-e2e.ts [graph-nickname]   (default sandbox-dg)
//
// Lives outside src/ so it never ships to dist. Imports the compiled-shape
// modules directly from ../src/*.js (NodeNext specifiers).

import { createClient } from "../src/roam.js";
import {
  getCanvasContext,
  resolveNodeType,
  resolveRelation,
  formatNodeTitle,
} from "../src/canvas/context.js";
import { readCanvasState, summarizeCanvas } from "../src/canvas/snapshot.js";
import { mutateCanvas, createCanvasPage } from "../src/canvas/write.js";
import {
  createNodeShapeRecord,
  createRelationRecords,
  createTextShapeRecord,
  expandDeletionSet,
  generateRoamUid,
  nextIndex,
  shapeNodeTypeId,
} from "../src/canvas/records.js";
import { resolvePage } from "../src/canvas/props.js";

const GRAPH = process.argv[2] ?? "sandbox-dg";
const STAMP = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const CANVAS_NAME = `mcp-e2e-${STAMP}`;
// existing sandbox canvases used for read assertions
const RELATIONS_CANVAS = "Canvas/testRelations";
const LEGACY_CANVAS = "Canvas/DGAI-vector-db";
const IMAGE_CANVAS_UID = "VVc4TR3BB"; // demo canvas that has a pasted image in a frame

let failures = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : ` :: ${JSON.stringify(detail)}`}`);
};

const main = async () => {
  const { client, nickname } = await createClient(GRAPH);
  console.log(`graph: ${nickname}`);

  const ctx = await getCanvasContext(client);
  const nodeCount = Object.keys(ctx.nodes).length;
  const relCount = Object.keys(ctx.relations).length;
  console.log(`node types: ${nodeCount}, relations: ${relCount}, canvas format: ${ctx.canvasPageFormat}`);
  check("config: node types discovered", nodeCount >= 3);
  check("config: relations discovered", relCount >= 2);
  const evd = resolveNodeType(ctx, "Evidence");
  const clm = resolveNodeType(ctx, "Claim");
  check("config: Evidence + Claim resolvable", !!evd && !!clm, Object.values(ctx.nodes).map((n) => n.text));
  if (!evd || !clm) throw new Error("cannot continue without node types");
  check("config: Evidence format looks right", /{content}/i.test(evd.format), evd);

  // read existing canvases
  const rel = summarizeCanvas(await readCanvasState(client, { title: RELATIONS_CANVAS }), ctx);
  check("read: testRelations 2 nodes", rel.nodes.length === 2, rel.nodes);
  check(
    "read: testRelations relation wired",
    rel.relations.length === 1 && !!rel.relations[0]?.fromShapeId && !!rel.relations[0]?.toShapeId,
    rel.relations,
  );

  const legacy = await readCanvasState(client, { title: LEGACY_CANVAS });
  check("read: legacy-raw detected", legacy.format === "legacy-raw");

  // image summarization (the previously-missed content type)
  const demo = summarizeCanvas(await readCanvasState(client, { uid: IMAGE_CANVAS_UID }), ctx);
  check(
    "read: image surfaced with src + frame",
    demo.images.length >= 1 && !!demo.images[0]?.src && demo.images[0]?.src.startsWith("http"),
    demo.images,
  );

  // create canvas
  const { pageUid, title } = await createCanvasPage(client, ctx, CANVAS_NAME);
  console.log(`created canvas: ${title} (${pageUid})`);
  const fresh = await readCanvasState(client, { uid: pageUid });
  check("create: snapshot format", fresh.format === "snapshot");
  check(
    "create: schema mirrors a current client save",
    fresh.schema?.sequences?.["com.tldraw.shape.discourse-node"] === 0 &&
      fresh.schema?.sequences?.["com.roam-research.discourse-graphs"] === 5 &&
      fresh.schema?.sequences?.[`com.tldraw.shape.${evd.id}`] === undefined,
    fresh.schema?.sequences,
  );

  // add two nodes
  const addNode = async (ref: string, text: string, x: number, y: number) => {
    const nodeType = resolveNodeType(ctx, ref)!;
    const nodeTitle = formatNodeTitle(nodeType, text);
    const existing = await resolvePage(client, { title: nodeTitle });
    let nodePageUid: string;
    if (existing) nodePageUid = existing.uid;
    else {
      nodePageUid = generateRoamUid();
      await client.call("data.page.fromMarkdown", [
        { page: { title: nodeTitle, uid: nodePageUid }, "markdown-string": "" },
      ]);
    }
    const res = await mutateCanvas(client, { uid: pageUid }, ctx, (store, helpers) => {
      const shape = createNodeShapeRecord({
        nodeType,
        uid: nodePageUid,
        title: nodeTitle,
        x,
        y,
        parentId: helpers.pageRecordId,
        index: nextIndex(store),
      });
      store[shape.id] = shape;
      return { shapeId: shape.id };
    });
    return { ...res, nodePageUid, nodeTitle };
  };
  const evdRes = await addNode("EVD", `e2e evidence ${STAMP}`, 100, 100);
  const clmRes = await addNode("Claim", `e2e claim ${STAMP}`, 560, 300);
  check("add_node: EVD title formatted", evdRes.nodeTitle.includes("EVD"), evdRes.nodeTitle);
  const evdShape = (await readCanvasState(client, { uid: pageUid })).store[evdRes.shapeId];
  check(
    "add_node: modern shape convention (discourse-node + props.nodeTypeId)",
    evdShape?.type === "discourse-node" &&
      (evdShape?.props as { nodeTypeId?: string } | undefined)?.nodeTypeId ===
        resolveNodeType(ctx, "EVD")!.id,
    evdShape,
  );

  // connect
  const connectRes = await mutateCanvas(client, { uid: pageUid }, ctx, (store, helpers) => {
    const fromShape = store[evdRes.shapeId]!;
    const toShape = store[clmRes.shapeId]!;
    const { relation } = resolveRelation(ctx, "Supports", {
      sourceTypeId: shapeNodeTypeId(fromShape),
      destinationTypeId: shapeNodeTypeId(toShape),
    });
    if (!relation) throw new Error("Supports not resolvable");
    const records = createRelationRecords({
      relation,
      fromShape,
      toShape,
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    for (const r of records) store[r.id] = r;
    return { relationId: relation.id };
  });
  check("connect: Supports resolved", !!ctx.relations[connectRes.relationId], connectRes);

  // text
  await mutateCanvas(client, { uid: pageUid }, ctx, (store, helpers) => {
    const t = createTextShapeRecord({
      text: "written by canvas e2e",
      x: 100,
      y: 500,
      parentId: helpers.pageRecordId,
      index: nextIndex(store),
    });
    store[t.id] = t;
    return {};
  });

  // read back
  const after = await readCanvasState(client, { uid: pageUid });
  const summary = summarizeCanvas(after, ctx);
  check("readback: 2 nodes", summary.nodes.length === 2, summary.nodes);
  check(
    "readback: relation wired to both node uids",
    summary.relations.length === 1 &&
      summary.relations[0]?.fromUid === evdRes.nodePageUid &&
      summary.relations[0]?.toUid === clmRes.nodePageUid,
    summary.relations,
  );
  check("readback: text present", summary.texts.some((t) => t.text === "written by canvas e2e"));
  check("readback: stateId changed", after.stateId !== fresh.stateId);
  check("readback: no loadability warnings", summary.warnings === undefined, summary.warnings);

  // node cascade delete (arrow + 2 bindings)
  const cascade = expandDeletionSet(after.store, [evdRes.shapeId]);
  check("delete: node cascade = arrow + 2 bindings", cascade.size === 4, [...cascade]);

  // cleanup: remove e2e canvas + created node pages
  await client.call("data.page.delete", [{ page: { uid: pageUid } }]);
  await client.call("data.page.delete", [{ page: { uid: evdRes.nodePageUid } }]);
  await client.call("data.page.delete", [{ page: { uid: clmRes.nodePageUid } }]);
  console.log("cleaned up e2e artifacts");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
  if (failures > 0) process.exit(1);
};

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
