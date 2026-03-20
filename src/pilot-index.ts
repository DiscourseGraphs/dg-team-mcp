// Pilot knowledge index — types and file I/O
// Stores classified pilot data on disk for instant querying.
// The calling LLM does classification; this module just handles persistence.

import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

const INDEX_DIR = join(homedir(), ".discourse-graph-mcp");
const INDEX_FILE = "pilot-index.json";
const INDEX_PATH = join(INDEX_DIR, INDEX_FILE);

export interface PilotTopicItem {
  text: string;
  uid: string;
  section: string;
  sentiment?: string;
}

export interface PilotTopic {
  summary: string;
  items: PilotTopicItem[];
}

export interface PilotEntry {
  name: string;
  page_uid: string;
  page_edit_time: number;
  last_indexed: string;
  profile: Record<string, string>;
  topics: Record<string, PilotTopic>;
}

export interface RollupItem {
  item: string;
  pilot_count: number;
  pilots: string[];
}

export interface Rollup {
  summary: string;
  ranked?: RollupItem[];
}

export interface PilotIndex {
  version: number;
  indexed_at: string;
  pilots: Record<string, PilotEntry>;
  rollups: Record<string, Rollup>;
}

export async function readPilotIndex(): Promise<PilotIndex | null> {
  try {
    const data = await readFile(INDEX_PATH, "utf-8");
    return JSON.parse(data) as PilotIndex;
  } catch {
    return null;
  }
}

export async function writePilotIndex(index: PilotIndex): Promise<string> {
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  return INDEX_PATH;
}

export function emptyIndex(): PilotIndex {
  return {
    version: 1,
    indexed_at: new Date().toISOString(),
    pilots: {},
    rollups: {},
  };
}

export { INDEX_PATH };
