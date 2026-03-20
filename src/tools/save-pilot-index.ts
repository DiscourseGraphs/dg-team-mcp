// Tool: save_pilot_index
// Write classified pilot data to the knowledge index on disk.
// Standalone — no Roam client needed, pure file I/O.
// Merges into existing index: pilot entries and rollup keys are overwritten,
// others are preserved.

import { z } from "zod";
import {
  readPilotIndex,
  writePilotIndex,
  emptyIndex,
  INDEX_PATH,
} from "../pilot-index.js";

const TopicItemSchema = z.object({
  text: z.string().describe("Block text"),
  uid: z.string().describe("Roam block UID for citation"),
  section: z.string().describe("Section heading this block was under"),
  sentiment: z
    .string()
    .optional()
    .describe("Sentiment: strong, moderate, neutral"),
});

const TopicSchema = z.object({
  summary: z
    .string()
    .describe("1-2 sentence summary of this topic for this pilot"),
  items: z
    .array(TopicItemSchema)
    .describe("Blocks supporting this classification"),
});

const PilotSchema = z.object({
  uid: z.string().describe("Pilot page UID"),
  name: z.string().describe("Pilot page title"),
  page_edit_time: z
    .number()
    .describe("Page edit timestamp (epoch ms) from extraction"),
  profile: z
    .record(z.string())
    .optional()
    .describe("Pilot metadata: lab, PI, focus, status, team_size, etc."),
  topics: z.record(TopicSchema).describe(
    "Classified topics. Use descriptive keys: feature_requests, pain_points, " +
      "workflow, feedback, challenges, interests, onboarding, etc. " +
      "Categories can evolve — use whatever fits the content.",
  ),
});

const RollupItemSchema = z.object({
  item: z.string().describe("The feature, pain point, or theme name"),
  pilot_count: z
    .number()
    .describe("Number of pilots mentioning this"),
  pilots: z
    .array(z.string())
    .describe("Names of pilots mentioning this"),
});

const RollupSchema = z.object({
  summary: z
    .string()
    .describe("Cross-pilot summary for this category"),
  ranked: z
    .array(RollupItemSchema)
    .optional()
    .describe("Items ranked by frequency"),
});

export const SavePilotIndexSchema = z.object({
  pilots: z
    .array(PilotSchema)
    .optional()
    .describe(
      "Classified pilot data to save/update. Each pilot overwrites its previous entry.",
    ),
  rollups: z
    .record(RollupSchema)
    .optional()
    .describe(
      "Cross-pilot summaries. Provide after all pilots are indexed. " +
        "Keys: feature_requests, pain_points, what_to_build_next, common_workflows, etc.",
    ),
});

export const savePilotIndexDescription =
  "Save classified pilot data to the knowledge index on disk. Call after " +
  "extracting pilot pages with extract_pilot_data and classifying the content. " +
  "Accepts per-pilot classifications and/or cross-pilot rollup summaries. " +
  "Each save merges into the existing index — pilot entries and rollup keys " +
  "are overwritten, others preserved.";

export const handleSavePilotIndex = async (
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const parsed = SavePilotIndexSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "Invalid input", details: parsed.error.issues },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const { pilots, rollups } = parsed.data;

  if (!pilots?.length && !rollups) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: "Provide at least one of: pilots, rollups" },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Read existing or create new
  const index = (await readPilotIndex()) ?? emptyIndex();
  const now = new Date().toISOString();

  // Merge pilots
  let pilotsUpdated = 0;
  if (pilots) {
    for (const pilot of pilots) {
      index.pilots[pilot.uid] = {
        name: pilot.name,
        page_uid: pilot.uid,
        page_edit_time: pilot.page_edit_time,
        last_indexed: now,
        profile: pilot.profile ?? {},
        topics: pilot.topics,
      };
      pilotsUpdated++;
    }
  }

  // Merge rollups
  let rollupsUpdated = 0;
  if (rollups) {
    for (const [key, rollup] of Object.entries(rollups)) {
      index.rollups[key] = rollup;
      rollupsUpdated++;
    }
  }

  index.indexed_at = now;

  const path = await writePilotIndex(index);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            saved: true,
            path,
            pilots_updated: pilotsUpdated,
            rollups_updated: rollupsUpdated,
            total_pilots_in_index: Object.keys(index.pilots).length,
            total_rollup_categories: Object.keys(index.rollups).length,
          },
          null,
          2,
        ),
      },
    ],
  };
};
