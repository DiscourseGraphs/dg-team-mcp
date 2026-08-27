// Headless record validation using tldraw 2.4.6 tlschema. Custom shape/binding
// types get permissive {} stubs (same pattern as the deployed sync worker) —
// built-in records still get full validation, which catches malformed authored
// props before they reach Roam.

import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
} from "@tldraw/tlschema";
import { Store } from "@tldraw/store";
import type { CanvasContext, SerializedSchema, SerializedStore } from "./model.js";
import { getAddReferencedNodeActions } from "./context.js";

export const DISCOURSE_SEQUENCE_ID = "com.roam-research.discourse-graphs";
// The client's migration sequence (discourseRelationMigrations.ts in the
// plugin). v5 = MigrateNodeTypeToDiscourseNode: it rewrites legacy node shapes
// (shape.type = node type id) to "discourse-node" on load, and since v5 the
// client registers no utils for the legacy types. A legacy node shape
// therefore only loads from a snapshot declaring version 4 or below.
export const DISCOURSE_SEQUENCE_VERSION = 5;
const LAST_LEGACY_NODE_VERSION = 4;

const BUILTIN_SHAPE_TYPES = new Set(Object.keys(defaultShapeSchemas));
const BUILTIN_BINDING_TYPES = new Set(Object.keys(defaultBindingSchemas));

export const collectCustomTypes = (
  store: SerializedStore,
  ctx: CanvasContext,
): { shapeTypes: string[]; bindingTypes: string[] } => {
  const shapeTypes = new Set<string>(["discourse-node", "discourse-relation"]);
  const bindingTypes = new Set<string>(["discourse-relation"]);
  for (const id of Object.keys(ctx.nodes)) shapeTypes.add(id);
  shapeTypes.add("page-node").add("blck-node");
  for (const id of Object.keys(ctx.relations)) {
    shapeTypes.add(id);
    bindingTypes.add(id);
  }
  for (const action of getAddReferencedNodeActions(ctx)) {
    shapeTypes.add(action);
    bindingTypes.add(action);
  }
  for (const record of Object.values(store)) {
    const type = record.type;
    if (typeof type !== "string") continue;
    if (record.typeName === "shape" && !BUILTIN_SHAPE_TYPES.has(type)) shapeTypes.add(type);
    if (record.typeName === "binding" && !BUILTIN_BINDING_TYPES.has(type)) bindingTypes.add(type);
  }
  return { shapeTypes: [...shapeTypes], bindingTypes: [...bindingTypes] };
};

/** Throws with a readable message when any record fails schema validation. */
export const validateStoreRecords = (
  store: SerializedStore,
  ctx: CanvasContext,
): void => {
  const { shapeTypes, bindingTypes } = collectCustomTypes(store, ctx);
  const schema = createTLSchema({
    shapes: {
      ...defaultShapeSchemas,
      ...Object.fromEntries(shapeTypes.map((t) => [t, {}])),
    },
    bindings: {
      ...defaultBindingSchemas,
      ...Object.fromEntries(bindingTypes.map((t) => [t, {}])),
    },
  });
  // tlschema/store generics require the concrete record union; we validate an
  // opaque authored store, so go through `any` here (the validation itself is
  // fully typed by tldraw at runtime).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scratch: any = new (Store as any)({ schema, props: { defaultName: "" } });
  try {
    scratch.put(Object.values(store));
  } catch (e) {
    throw new Error(
      `Refusing to write: records failed tldraw 2.4.6 validation — ${(e as Error).message}`,
    );
  }
};

/**
 * Shape and binding types the CURRENT deployed client registers for every
 * canvas: the unified node and relation types, one type per relation id, and
 * one per "Add <Token>" referenced-node action. Node type ids are NOT here —
 * since discourse schema v5 the client loads them only via migration.
 */
const currentClientTypes = (ctx: CanvasContext): Set<string> => {
  const types = new Set<string>(["discourse-node", "discourse-relation"]);
  for (const id of Object.keys(ctx.relations)) types.add(id);
  for (const action of getAddReferencedNodeActions(ctx)) types.add(action);
  return types;
};

const legacyNodeTypeIds = (ctx: CanvasContext): Set<string> =>
  new Set([...Object.keys(ctx.nodes), "page-node", "blck-node"]);

/**
 * Would the current Roam client load every record in this snapshot? Returns
 * one message per record it would reject. A single rejected record makes the
 * WHOLE canvas unopenable in the app, so writes treat any issue as fatal and
 * reads surface them as warnings.
 */
export const findUnloadableRecords = (
  store: SerializedStore,
  schema: SerializedSchema | null,
  ctx: CanvasContext,
): string[] => {
  const sequences = schema?.sequences ?? {};
  const discourseVersion = sequences[DISCOURSE_SEQUENCE_ID] ?? 0;
  const current = currentClientTypes(ctx);
  const legacyNodes = legacyNodeTypeIds(ctx);
  const issues: string[] = [];
  for (const record of Object.values(store)) {
    const typeName = record.typeName;
    if (typeName !== "shape" && typeName !== "binding") continue;
    const type = typeof record.type === "string" ? record.type : "";
    const builtins = typeName === "shape" ? BUILTIN_SHAPE_TYPES : BUILTIN_BINDING_TYPES;
    if (builtins.has(type) || current.has(type)) continue;
    if (typeName === "shape" && legacyNodes.has(type)) {
      // The client migration rewrites these on load, but only from snapshots
      // declaring a pre-v5 discourse schema.
      if (discourseVersion <= LAST_LEGACY_NODE_VERSION) continue;
      issues.push(
        `${record.id} uses legacy shape.type "${type}" in a snapshot at discourse schema v${String(discourseVersion)}; the client rewrite to "discourse-node" only runs for v${LAST_LEGACY_NODE_VERSION} and below, so the canvas will not open (put the node type id in props.nodeTypeId instead)`,
      );
      continue;
    }
    // Declared by whichever client last saved the canvas; trust it.
    if (`com.tldraw.${typeName}.${type}` in sequences) continue;
    issues.push(
      `${record.id} has ${typeName} type "${type}", which no current client registers and the canvas schema does not declare; the canvas will not open`,
    );
  }
  return issues;
};

/** Tool-boundary gate: refuse to write a snapshot the client would refuse to load. */
export const assertRecordsLoadable = (
  store: SerializedStore,
  schema: SerializedSchema | null,
  ctx: CanvasContext,
): void => {
  const issues = findUnloadableRecords(store, schema, ctx);
  if (issues.length) {
    throw new Error(`Refusing to write: ${issues.join("; ")}`);
  }
};
