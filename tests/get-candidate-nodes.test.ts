// get_candidate_nodes' pure layer: tag normalization across the shapes real
// configs use, type resolution (id / name / format tag / candidate tag), and
// the promoted-in-place heuristic. The tag-to-type mapping comes from config,
// never derivation — dg-team's #flow-candidate (FLO), #up-candidate
// (UserPilot), and painpoint (PainPoint) are underivable on purpose here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateBlocksQuery,
  normalizeCandidateTag,
  referencesFormalNode,
  resolveCandidateType,
} from "../src/tools/get-candidate-nodes.js";
import type { InternalDiscourseNodeType } from "../src/types.js";

const nodeType = (
  over: Partial<InternalDiscourseNodeType>,
): InternalDiscourseNodeType =>
  ({
    name: "Evidence",
    typeId: "zsoX6_bEl",
    format: "[[EVD]] - {content} - {Source}",
    shortcut: "E",
    tag: "#evd-candidate",
    description: "",
    canvasSettings: {},
    graphOverview: true,
    backedBy: "user",
    specification: [],
    template: [],
    ...over,
  }) as InternalDiscourseNodeType;

// Real tag values observed in dg-team's config: "#evd-candidate",
// "us-candidate" (no hash), "painpoint" (no -candidate suffix).
test("normalizeCandidateTag handles the shapes real configs use", () => {
  assert.equal(normalizeCandidateTag("#evd-candidate"), "evd-candidate");
  assert.equal(normalizeCandidateTag("us-candidate"), "us-candidate");
  assert.equal(normalizeCandidateTag("painpoint"), "painpoint");
  assert.equal(normalizeCandidateTag("#[[evd-candidate]]"), "evd-candidate");
  assert.equal(normalizeCandidateTag("[[evd-candidate]]"), "evd-candidate");
  assert.equal(normalizeCandidateTag("  #hyp-candidate  "), "hyp-candidate");
  assert.equal(normalizeCandidateTag(""), "");
  assert.equal(normalizeCandidateTag("#"), "");
});

const flow = nodeType({
  name: "Flow",
  typeId: "yF_Q8LBPX",
  format: "[[FLO]] - {content}",
  tag: "#flow-candidate",
});
const userPilot = nodeType({
  name: "UserPilot",
  typeId: "cpaMjD1FT",
  format: "UserPilot/{content}",
  tag: "#up-candidate",
});
const evidence = nodeType({});
const milestone = nodeType({
  name: "Milestone",
  typeId: "0Ww0WSx4U",
  format: "Milestone/{content}",
  tag: "",
});
const all = [evidence, flow, userPilot, milestone];

test("resolveCandidateType matches id, name, format tag, and candidate tag", () => {
  assert.equal(resolveCandidateType(all, "zsoX6_bEl"), evidence);
  assert.equal(resolveCandidateType(all, "evidence"), evidence);
  assert.equal(resolveCandidateType(all, "EVD"), evidence);
  assert.equal(resolveCandidateType(all, "evd-candidate"), evidence);
  // FLO's tag is flow-candidate, not flo-candidate — format tag still resolves
  assert.equal(resolveCandidateType(all, "FLO"), flow);
  assert.equal(resolveCandidateType(all, "flow-candidate"), flow);
  // UserPilot has no [[…]] format tag; name and tag stem both work
  assert.equal(resolveCandidateType(all, "UserPilot"), userPilot);
  assert.equal(resolveCandidateType(all, "up"), userPilot);
  assert.equal(resolveCandidateType(all, "nope"), undefined);
  // an empty tag must not swallow every stem
  assert.equal(resolveCandidateType(all, "milestone"), milestone);
});

test("referencesFormalNode flags promoted-in-place candidates", () => {
  assert.equal(
    referencesFormalNode(
      "[[[[EVD]] - actin assembles - [[@smith2020]]]] #evd-candidate",
      evidence.format,
    ),
    true,
  );
  assert.equal(
    referencesFormalNode(
      "actin assembles under load #evd-candidate",
      evidence.format,
    ),
    false,
  );
  assert.equal(
    referencesFormalNode("try the [[UserPilot/Allen]] angle", userPilot.format),
    true,
  );
  assert.equal(referencesFormalNode("anything", ""), false);
});

test("candidateBlocksQuery binds tag title and since as inputs", () => {
  assert.ok(candidateBlocksQuery.includes(":in $ ?tag-title ?since"));
  assert.ok(candidateBlocksQuery.includes('[?tag :node/title ?tag-title]'));
  assert.ok(candidateBlocksQuery.includes("[?b :block/refs ?tag]"));
  assert.ok(candidateBlocksQuery.includes("[(>= ?editTime ?since)]"));
  // create-time is optional too: old imports may lack it entirely
  assert.ok(candidateBlocksQuery.includes("(get-else $ ?b :create/time 0)"));
  // author shape mirrors get_all_discourse_nodes, but author is optional:
  // blocks without :create/user (old imports) must still be returned
  assert.ok(candidateBlocksQuery.includes(":user/display-name"));
  assert.ok(candidateBlocksQuery.includes("(missing? $ ?b :create/user)"));
});
