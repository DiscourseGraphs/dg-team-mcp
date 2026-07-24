// Canvas-facing view of the graph's discourse config. Discovery itself is
// reused from ../discourse-config.js (getInternalDiscourseConfig); this module
// only reshapes it into id-keyed maps + adds the canvas page format, and
// provides the small resolve/format helpers the canvas tools need.

import type { RoamClient } from "@roam-research/roam-tools-local";
import { getInternalDiscourseConfig } from "../discourse-config.js";
import { getConfigPageUid, datalogQuery } from "../roam.js";
import { getPageProps } from "./props.js";
import type { CanvasContext, CanvasNodeType, CanvasRelationType } from "./model.js";

const DEFAULT_CANVAS_PAGE_FORMAT = "Canvas/*";

const getCanvasPageFormat = async (client: RoamClient): Promise<string> => {
  // Best-effort: the "Canvas page format" global setting lives in the props of
  // the config page's "Global" child block. Falls back to the default, which
  // is what essentially every graph uses.
  try {
    const configUid = await getConfigPageUid(client);
    if (!configUid) return DEFAULT_CANVAS_PAGE_FORMAT;
    const rows = await datalogQuery<[string]>(
      client,
      `[:find ?uid :where [?p :block/uid "${configUid}"] [?p :block/children ?c] [?c :block/string "Global"] [?c :block/uid ?uid]]`,
    );
    const globalUid = rows?.[0]?.[0];
    if (!globalUid) return DEFAULT_CANVAS_PAGE_FORMAT;
    const props = await getPageProps(client, globalUid);
    for (const [key, value] of Object.entries(props)) {
      if (key.toLowerCase() === "canvas page format" && typeof value === "string" && value) {
        return value;
      }
    }
  } catch {
    // ignore — default is safe
  }
  return DEFAULT_CANVAS_PAGE_FORMAT;
};

export const getCanvasContext = async (client: RoamClient): Promise<CanvasContext> => {
  const internal = await getInternalDiscourseConfig(client);

  const nodes: Record<string, CanvasNodeType> = {};
  for (const n of internal.nodes) {
    nodes[n.typeId] = {
      id: n.typeId,
      text: n.name,
      format: n.format,
      shortcut: n.shortcut,
      color: n.canvasSettings?.color || undefined,
    };
  }

  const relations: Record<string, CanvasRelationType> = {};
  for (const r of internal.relations) {
    if (r.id && !relations[r.id]) {
      relations[r.id] = {
        id: r.id,
        label: r.label,
        source: r.source || undefined,
        destination: r.destination || undefined,
        complement: r.complement || undefined,
      };
    }
  }

  const canvasPageFormat = await getCanvasPageFormat(client);
  return { nodes, relations, canvasPageFormat };
};

/** Tag from the format string, e.g. "[[EVD]] - {content}" → "EVD". */
const formatTag = (node: CanvasNodeType): string | undefined =>
  node.format.match(/\[\[([^\]]+)\]\]/)?.[1];

/** Resolve a node type by id, name, format tag (EVD/CLM/…), or shortcut. */
export const resolveNodeType = (
  ctx: CanvasContext,
  ref: string,
): CanvasNodeType | undefined => {
  if (ctx.nodes[ref]) return ctx.nodes[ref];
  const lower = ref.toLowerCase();
  const all = Object.values(ctx.nodes);
  return (
    all.find((n) => n.text.toLowerCase() === lower) ??
    all.find((n) => formatTag(n)?.toLowerCase() === lower) ??
    all.find((n) => n.shortcut.toLowerCase() === lower)
  );
};

/**
 * Resolve a relation by id or label. When a label is ambiguous, prefer the
 * candidate whose source/destination node types match the endpoints.
 */
export const resolveRelation = (
  ctx: CanvasContext,
  ref: string,
  endpoints?: { sourceTypeId?: string; destinationTypeId?: string },
): { relation?: CanvasRelationType; ambiguous?: CanvasRelationType[] } => {
  if (ctx.relations[ref]) return { relation: ctx.relations[ref] };
  const lower = ref.toLowerCase();
  const byLabel = Object.values(ctx.relations).filter(
    (r) => r.label.toLowerCase() === lower,
  );
  if (byLabel.length === 1) return { relation: byLabel[0] };
  if (byLabel.length > 1 && endpoints) {
    const matching = byLabel.filter(
      (r) =>
        (!r.source || !endpoints.sourceTypeId || r.source === endpoints.sourceTypeId) &&
        (!r.destination ||
          !endpoints.destinationTypeId ||
          r.destination === endpoints.destinationTypeId),
    );
    if (matching.length === 1) return { relation: matching[0] };
    if (matching.length > 1) return { ambiguous: matching };
  }
  if (byLabel.length > 1) return { ambiguous: byLabel };
  return {};
};

/**
 * Format a discourse node title from the node's format string.
 * v1 substitutes {content}; other {Token} placeholders are dropped with
 * separator tidy-up (referenced-node resolution is a follow-up).
 */
export const formatNodeTitle = (node: CanvasNodeType, content: string): string => {
  const format = node.format || "{content}";
  let title = format.replace(/{content}/gi, content);
  title = title.replace(/\s*-\s*{[^}]+}/g, "").replace(/{[^}]+}\s*-\s*/g, "");
  title = title.replace(/{[^}]+}/g, "").trim();
  return title;
};

/** "Add <Token>" action names derived from node formats (for schema assembly). */
export const getAddReferencedNodeActions = (ctx: CanvasContext): string[] => {
  const actions = new Set<string>();
  for (const node of Object.values(ctx.nodes)) {
    for (const match of node.format.matchAll(/{([^}]+)}/g)) {
      const token = match[1]?.trim();
      if (token && token.toLowerCase() !== "content") actions.add(`Add ${token}`);
    }
  }
  return [...actions].sort();
};
