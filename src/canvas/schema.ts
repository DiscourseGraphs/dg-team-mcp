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
import type { CanvasContext, SerializedStore } from "./model.js";
import { getAddReferencedNodeActions } from "./context.js";

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
