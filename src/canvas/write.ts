// Read-modify-write of canvas snapshots, honoring the app's save contract:
// preserve all sibling props keys, carry the schema through verbatim, fresh
// stateId each write, and keep the read→write window minimal (the app's own
// save throttle is 350ms). Absent record ids read as deletions on live
// clients, so every write re-reads immediately before mutating.

import type { RoamClient } from "@roam-research/roam-tools-local";
import type {
  CanvasContext,
  CanvasPageState,
  CanvasSnapshot,
  JsonObject,
  SerializedSchema,
  SerializedStore,
} from "./model.js";
import { readCanvasState } from "./snapshot.js";
import { getPageRecordId, generateRoamUid, newStateId } from "./records.js";
import { getAddReferencedNodeActions } from "./context.js";
import { EMPTY_CANVAS_SNAPSHOT } from "./fixtures/emptyCanvas.js";
import { validateStoreRecords } from "./schema.js";
import { resolvePage } from "./props.js";

const RJSQB_KEY = "roamjs-query-builder";

// Built-in tldraw 2.4.6 sequence ids; everything else in a persisted schema is
// per-graph custom and must be rebuilt for the target graph on bootstrap.
const BUILTIN_SEQUENCE_PATTERN =
  /^com\.tldraw\.(store|document|asset|camera|instance|instance_page_state|instance_presence|page|pointer|shape|binding)$|^com\.tldraw\.shape\.(arrow|bookmark|draw|embed|frame|geo|group|highlight|image|line|note|text|video)$|^com\.tldraw\.asset\.(image|video|bookmark)$|^com\.tldraw\.binding\.arrow$/;

const DISCOURSE_SEQUENCE_ID = "com.roam-research.discourse-graphs";

export const buildBootstrapSnapshot = (ctx: CanvasContext): CanvasSnapshot => {
  const fixture = EMPTY_CANVAS_SNAPSHOT;
  const sequences: Record<string, number> = {};
  for (const [id, version] of Object.entries(fixture.schema.sequences)) {
    if (BUILTIN_SEQUENCE_PATTERN.test(id)) sequences[id] = version;
  }
  sequences[DISCOURSE_SEQUENCE_ID] = fixture.schema.sequences[DISCOURSE_SEQUENCE_ID] ?? 3;
  const customShapeIds = [
    ...Object.keys(ctx.nodes),
    "page-node",
    "blck-node",
    ...Object.keys(ctx.relations),
    ...getAddReferencedNodeActions(ctx),
  ];
  for (const id of customShapeIds) sequences[`com.tldraw.shape.${id}`] = 0;
  for (const id of [...Object.keys(ctx.relations), ...getAddReferencedNodeActions(ctx)]) {
    sequences[`com.tldraw.binding.${id}`] = 0;
  }
  return {
    store: structuredClone(fixture.store),
    schema: { schemaVersion: fixture.schema.schemaVersion, sequences },
  };
};

const writeCanvasProps = async (
  client: RoamClient,
  state: CanvasPageState,
  store: SerializedStore,
  schema: SerializedSchema,
): Promise<string> => {
  const stateId = newStateId();
  const props: JsonObject = {
    ...state.allProps,
    [RJSQB_KEY]: {
      ...state.rjsqbSiblings,
      stateId,
      tldraw: { store, schema },
    },
  };
  await client.call("data.page.update", [{ page: { uid: state.pageUid, props } }]);
  return stateId;
};

// Open-client mitigation (README "Writes to a canvas that is OPEN in Roam"):
// the extension's ingest pull-watch misses Local-API props-only writes, and its
// save path whole-snapshot-overwrites without checking the props stateId — so a
// client that never ingested our records silently drops them on the user's next
// edit. The watch pattern also covers :block/children, and touching the page's
// children fires it deterministically, so after every props write we create and
// then delete a throwaway block on the canvas page to force prompt ingest.

// Keep the throwaway block alive past the client's 350 ms ingest debounce so
// the create and delete transactions can't collapse into a no-op for the watch.
const NUDGE_INGEST_DELAY_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const nudgeOpenCanvasClients = async (
  client: RoamClient,
  pageUid: string,
  opts?: { ingestDelayMs?: number },
): Promise<boolean> => {
  const created = await client.call<{ uids?: string[] }>("data.block.fromMarkdown", [
    { location: { "parent-uid": pageUid, order: "last" }, "markdown-string": "-" },
  ]);
  const uid = created.result?.uids?.[0];
  if (!uid) return false;
  await sleep(opts?.ingestDelayMs ?? NUDGE_INGEST_DELAY_MS);
  await client.call("data.block.delete", [{ block: { uid } }]);
  return true;
};

/**
 * Is the canvas page visible in Roam on this machine (main window or right
 * sidebar)? Sees only the local desktop app — another collaborator's open
 * client is invisible here, which is why the nudge runs unconditionally.
 */
export const isCanvasOpenInRoam = async (
  client: RoamClient,
  pageUid: string,
): Promise<boolean | "unknown"> => {
  try {
    const [main, sidebar] = await Promise.all([
      client.call("ui.mainWindow.getOpenView", []),
      client.call("ui.rightSidebar.getWindows", []),
    ]);
    // View descriptors carry the uid under version-dependent keys; a substring
    // scan over the serialized descriptors is shape-agnostic.
    return JSON.stringify([main.result ?? null, sidebar.result ?? []]).includes(pageUid);
  } catch {
    return "unknown";
  }
};

export type MutationHelpers = { pageRecordId: string };

/**
 * Fresh-read the canvas, apply `fn` to a mutable copy of the store, validate,
 * and write back. `fn` throwing aborts the write.
 */
export const mutateCanvas = async <T>(
  client: RoamClient,
  ref: { title?: string; uid?: string },
  ctx: CanvasContext,
  fn: (store: SerializedStore, helpers: MutationHelpers) => T,
): Promise<
  T & {
    stateId: string;
    canvasOpenInRoam: boolean | "unknown";
    clientNudged: boolean;
    note?: string;
  }
> => {
  const state = await readCanvasState(client, ref);
  if (state.format === "legacy-raw") {
    throw new Error(
      `"${state.title}" uses the pre-upgrade snapshot format. Open it in Roam and accept the canvas upgrade prompt, then retry. (Reads still work via canvas_read.)`,
    );
  }
  let store: SerializedStore;
  let schema: SerializedSchema;
  if (state.format === "none") {
    const bootstrap = buildBootstrapSnapshot(ctx);
    store = bootstrap.store;
    schema = bootstrap.schema;
  } else {
    store = structuredClone(state.store);
    schema = state.schema as SerializedSchema;
  }
  const result = fn(store, { pageRecordId: getPageRecordId(store) });
  validateStoreRecords(store, ctx);
  const stateId = await writeCanvasProps(client, state, store, schema);
  // Both are best-effort: the props write has already succeeded.
  const [canvasOpenInRoam, clientNudged] = await Promise.all([
    isCanvasOpenInRoam(client, state.pageUid),
    nudgeOpenCanvasClients(client, state.pageUid).catch(() => false),
  ]);
  return {
    ...result,
    stateId,
    canvasOpenInRoam,
    clientNudged,
    ...(canvasOpenInRoam === true
      ? {
          note: "Canvas is open in Roam on this machine — wrote and nudged the client to ingest; verify visually.",
        }
      : {}),
  };
};

/** Create a new canvas page (title per the graph's canvas page format) with an empty snapshot. */
export const createCanvasPage = async (
  client: RoamClient,
  ctx: CanvasContext,
  name: string,
): Promise<{ pageUid: string; title: string }> => {
  const format = ctx.canvasPageFormat;
  const title = format.includes("*") ? format.replace("*", name) : `${format}${name}`;
  const existing = await resolvePage(client, { title });
  if (existing) {
    throw new Error(`Canvas "${title}" already exists (uid ${existing.uid}).`);
  }
  const uid = generateRoamUid();
  await client.call("data.page.fromMarkdown", [
    { page: { title, uid }, "markdown-string": "" },
  ]);
  const created = await resolvePage(client, { title });
  const pageUid = created?.uid ?? uid;
  const state = await readCanvasState(client, { uid: pageUid });
  const bootstrap = buildBootstrapSnapshot(ctx);
  await writeCanvasProps(client, state, bootstrap.store, bootstrap.schema);
  return { pageUid, title };
};
