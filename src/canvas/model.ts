// Types for the canvas layer. Record shapes mirror what the deployed Roam
// discourse-graph extension (tldraw 2.4.6) persists in page props.
// See canvas/README.md for the reverse-engineered contract.

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type TldrawRecord = JsonObject & {
  id: string;
  typeName: string;
};

export type SerializedStore = Record<string, TldrawRecord>;

export type SerializedSchema = {
  schemaVersion: number;
  sequences: Record<string, number>;
};

export type CanvasSnapshot = {
  store: SerializedStore;
  schema: SerializedSchema;
};

/** Parsed state of a canvas page's persisted props. */
export type CanvasPageState = {
  pageUid: string;
  title: string;
  /** "snapshot" = modern {store,schema}; "legacy-raw" = bare store (read-only); "none" = no tldraw yet */
  format: "snapshot" | "legacy-raw" | "none";
  store: SerializedStore;
  schema: SerializedSchema | null;
  stateId: string | null;
  /** All top-level props keys (preserved verbatim on write). */
  allProps: JsonObject;
  /** Keys under "roamjs-query-builder" besides tldraw/stateId (preserved on write). */
  rjsqbSiblings: JsonObject;
};

/** Canvas-facing node type (reshaped from the repo's DiscourseNodeType). */
export type CanvasNodeType = {
  /** Node type id = discourse-graph/nodes page uid (or default id like "_CLM-node"). */
  id: string;
  text: string;
  format: string;
  shortcut: string;
  color?: string;
};

/** Canvas-facing relation type (reshaped from the repo's DiscourseRelationType). */
export type CanvasRelationType = {
  id: string;
  label: string;
  source?: string;
  destination?: string;
  complement?: string;
};

export type CanvasContext = {
  nodes: Record<string, CanvasNodeType>;
  relations: Record<string, CanvasRelationType>;
  canvasPageFormat: string;
};

/** Agent-facing summary of one canvas. */
export type CanvasSummary = {
  pageUid: string;
  title: string;
  format: CanvasPageState["format"];
  /** Tldraw pages on this board, in board order. `page` on items below names
   *  one of these; it is only set when the board has more than one page. */
  pages: Array<{ id: string; name: string; index: string }>;
  nodes: Array<{
    shapeId: string;
    nodeTypeId: string;
    nodeTypeText?: string;
    uid: string;
    title: string;
    x: number;
    y: number;
    w: number;
    h: number;
    frame?: string;
    page?: string;
  }>;
  relations: Array<{
    shapeId: string;
    relationId: string;
    label: string;
    fromShapeId?: string;
    toShapeId?: string;
    fromUid?: string;
    toUid?: string;
  }>;
  texts: Array<{
    shapeId: string;
    text: string;
    x: number;
    y: number;
    frame?: string;
    page?: string;
  }>;
  frames: Array<{
    shapeId: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    page?: string;
  }>;
  images: Array<{
    shapeId: string;
    name: string;
    src: string;
    x: number;
    y: number;
    w: number;
    h: number;
    frame?: string;
    page?: string;
  }>;
  otherShapes: Array<{ shapeId: string; type: string; frame?: string; page?: string }>;
  /** Records the current Roam client would refuse to load. One bad record makes the whole canvas unopenable. */
  warnings?: string[];
};
