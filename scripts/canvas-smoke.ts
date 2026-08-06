// Smoke-test the canvas tools through the real MCP server over stdio, with the
// DG_MCP_CANVAS_TOOLS group enabled. Run: npx tsx scripts/canvas-smoke.ts [graph]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const graph = process.argv[2] ?? "sandbox-dg";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist/index.js")],
  env: { ...process.env, DG_MCP_CANVAS_TOOLS: "1" } as Record<string, string>,
});
const client = new Client({ name: "canvas-smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : ` :: ${JSON.stringify(detail)?.slice(0, 200)}`}`);
};
const textOf = (res: { content: unknown }) =>
  (res.content as Array<{ text?: string }>)[0]?.text ?? "";

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
const expected = [
  "canvas_list", "canvas_types", "canvas_read", "canvas_create", "canvas_add_node",
  "canvas_connect", "canvas_add_text", "canvas_create_frame", "canvas_move", "canvas_delete",
];
check("all 10 canvas tools registered", expected.every((n) => names.includes(n)), names.filter((n) => n.startsWith("canvas")));

const types = await client.callTool({ name: "canvas_types", arguments: { graph } });
check("canvas_types returns node + relation types", textOf(types).includes("nodeTypes") && textOf(types).includes("canvasPageFormat"));

const list = await client.callTool({ name: "canvas_list", arguments: { graph } });
check("canvas_list returns canvases", textOf(list).includes("canvasPageFormat") && textOf(list).includes("Canvas/"));

const read = await client.callTool({ name: "canvas_read", arguments: { graph, canvas: "Canvas/testRelations" } });
check("canvas_read summarizes a canvas", textOf(read).includes('"relations"') && textOf(read).includes('"nodes"'));

const bogus = await client.callTool({ name: "canvas_read", arguments: { graph, canvas: "Canvas/does-not-exist-xyz" } });
check("canvas_read errors on missing canvas", bogus.isError === true);

await client.close();
console.log(`\n${failures === 0 ? "SMOKE PASS" : `${failures} FAILURES`}`);
if (failures > 0) process.exit(1);
