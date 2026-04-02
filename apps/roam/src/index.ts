import styles from "./styles.css";

// ── Types ──

type RoamEntity = Record<string, unknown>;

type ProposedWriteBranch = {
  label?: string;
  markdown: string;
};

type PendingBatch = {
  batchId: string;
  blockCount: number;
  branchCount: number;
  createdAt: string;
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writes: ProposedWriteBranch[];
};

type BlockNode = {
  content: string;
  children: BlockNode[];
};

type ResolvedBatch = PendingBatch & {
  kind: "page" | "block";
  pageUid: string;
  pageTitle: string;
  parentLabel: string;
  breadcrumb: string[];
  trees: BlockNode[][];
};

type RoamOnloadArgs = {
  extensionAPI?: unknown;
};

declare global {
  interface Window {
    roamAlphaAPI: {
      pull: (pattern: string, target: [string, string]) => RoamEntity | null;
      q: (query: string) => unknown[][];
      createBlock: (args: {
        location: { "parent-uid": string; order: "last" | number };
        block: { string: string; uid?: string };
      }) => Promise<void>;
      updateBlock: (args: {
        block: { uid: string; open?: boolean; string?: string };
      }) => Promise<void>;
      ui: {
        mainWindow: {
          openBlock: (args: { block: { uid: string } }) => Promise<unknown>;
          openPage: (args: { page: { uid: string } }) => Promise<unknown>;
        };
      };
    };
    dgMcpWriteLocator?: {
      getState: () => unknown;
      refresh: () => Promise<void>;
    };
  }
}

// ── Constants ──

const BRIDGE_URL = "http://127.0.0.1:3597";
const STYLE_ID = "dg-mcp-locator-style";
const PILL_ID = "dg-mcp-write-pill";
const PENDING_CONTAINER_CLASS = "dg-mcp-pending-container";
const POLL_MS = 1200;

// ── Markdown parser ──

function parseMarkdownBranch(markdown: string): BlockNode[] {
  const lines = markdown.split(/\r?\n/);
  const root: BlockNode[] = [];
  const stack: { node: BlockNode; indent: number }[] = [];

  for (const line of lines) {
    const match = line.match(/^(\s*)-\s+(.*)/);
    if (!match) continue;
    const indent = match[1].length;
    const content = match[2].trimEnd();
    const node: BlockNode = { content, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ node, indent });
  }

  return root;
}

function countNodes(nodes: BlockNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

// ── UID generator ──

function generateUid(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let uid = "";
  for (let i = 0; i < 9; i++) {
    uid += chars[Math.floor(Math.random() * chars.length)];
  }
  return uid;
}

// ── Roam helpers ──

const pull = (uid: string) =>
  window.roamAlphaAPI.pull("[:block/uid :node/title :block/string]", [":block/uid", uid]);

const query = <T extends unknown[]>(q: string) =>
  (window.roamAlphaAPI.q(q) as T[]) || [];

function getPageInfo(uid: string): { uid: string; title: string } {
  const entity = pull(uid);
  const title = entity?.[":node/title"];
  if (typeof title === "string" && title) return { uid, title };

  const rows = query<[string, string]>(
    `[:find ?pu ?t :where [?b :block/uid "${uid}"] [?b :block/page ?p] [?p :block/uid ?pu] [?p :node/title ?t]]`,
  );
  return { uid: rows[0]?.[0] || uid, title: rows[0]?.[1] || "Unknown" };
}

function getBlockString(uid: string): string {
  const entity = pull(uid);
  const s = entity?.[":block/string"];
  return typeof s === "string" ? s : "";
}

function getParentUid(uid: string): string | undefined {
  const rows = query<[string]>(
    `[:find ?pu :where [?c :block/uid "${uid}"] [?p :block/children ?c] [?p :block/uid ?pu]]`,
  );
  return rows[0]?.[0];
}

function clip(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "\u2026";
}

// ── Resolve target context ──

function resolveBatch(batch: PendingBatch): ResolvedBatch | null {
  const entity = pull(batch.parentUid);
  if (!entity) return null;

  const pageTitle = entity[":node/title"];
  const isPage = typeof pageTitle === "string" && !!pageTitle;

  const page = isPage
    ? { uid: batch.parentUid, title: pageTitle as string }
    : getPageInfo(batch.parentUid);

  const breadcrumb: string[] = [page.title];
  if (!isPage) {
    let cur = batch.parentUid;
    const ancestors: string[] = [];
    for (;;) {
      const parent = getParentUid(cur);
      if (!parent) break;
      ancestors.unshift(clip(getBlockString(parent) || "?"));
      cur = parent;
    }
    breadcrumb.push(...ancestors, clip(getBlockString(batch.parentUid) || "?"));
  }

  const trees = batch.writes.map((w) => parseMarkdownBranch(w.markdown));

  return {
    ...batch,
    kind: isPage ? "page" : "block",
    pageUid: page.uid,
    pageTitle: page.title,
    parentLabel: isPage ? page.title : clip(getBlockString(batch.parentUid)),
    breadcrumb,
    trees,
  };
}

// ── Find DOM elements ──

function findBlockContainer(uid: string): HTMLElement | null {
  const block = document.querySelector<HTMLElement>(`.roam-block[id*="${uid}"]`);
  if (block) return block.closest<HTMLElement>(".roam-block-container") || block;
  return document.querySelector<HTMLElement>(`.roam-block-container[id*="${uid}"]`);
}

function findAppendPoint(batch: ResolvedBatch): HTMLElement | null {
  if (batch.kind === "page") {
    const titleEl = document.querySelector<HTMLElement>(
      `.rm-title-display-container[data-page-uid="${batch.parentUid}"]`,
    );
    const root = titleEl?.closest<HTMLElement>(".roam-article, .rm-sidebar-outline");
    return root?.querySelector<HTMLElement>(".rm-block-children") || null;
  }

  const container = findBlockContainer(batch.parentUid);
  if (!container) return null;

  return (
    container.querySelector<HTMLElement>(":scope > .rm-block-children") ||
    container.querySelector<HTMLElement>(":scope > .rm-block-main") ||
    container
  );
}

// ── Create blocks in Roam ──

async function createBlockTree(parentUid: string, nodes: BlockNode[]): Promise<void> {
  for (const node of nodes) {
    const uid = generateUid();
    await window.roamAlphaAPI.createBlock({
      location: { "parent-uid": parentUid, order: "last" },
      block: { string: node.content, uid },
    });
    if (node.children.length > 0) {
      await createBlockTree(uid, node.children);
    }
  }
}

// ── Virtual block renderer ──

function renderBlockLine(
  node: BlockNode,
  depth: number,
  collapsed: boolean,
  onToggle?: () => void,
): HTMLElement {
  const line = document.createElement("div");
  line.className = "dg-mcp-pending-line";

  if (depth > 0) {
    const indent = document.createElement("span");
    indent.className = "dg-mcp-pending-indent";
    indent.style.width = `${depth * 22}px`;
    line.appendChild(indent);
  }

  if (node.children.length > 0) {
    const toggle = document.createElement("span");
    toggle.className = "dg-mcp-pending-toggle";
    toggle.textContent = collapsed ? "\u25B8" : "\u25BE";
    toggle.addEventListener("click", () => onToggle?.());
    line.appendChild(toggle);
  } else {
    const bullet = document.createElement("span");
    bullet.className = "dg-mcp-pending-bullet";
    bullet.textContent = "\u2022";
    line.appendChild(bullet);
  }

  const text = document.createElement("span");
  text.className = "dg-mcp-pending-text";
  text.textContent = node.content;
  line.appendChild(text);

  if (collapsed && node.children.length > 0) {
    const count = document.createElement("span");
    count.className = "dg-mcp-pending-count";
    count.textContent = `(${countNodes(node.children)})`;
    line.appendChild(count);
  }

  return line;
}

function renderTree(
  container: HTMLElement,
  nodes: BlockNode[],
  depth: number,
  collapsedSet: Set<BlockNode>,
): void {
  for (const node of nodes) {
    const isCollapsed = collapsedSet.has(node);

    const line = renderBlockLine(node, depth, isCollapsed, () => {
      if (collapsedSet.has(node)) {
        collapsedSet.delete(node);
      } else {
        collapsedSet.add(node);
      }
      renderAllPending();
    });
    container.appendChild(line);

    if (!isCollapsed && node.children.length > 0) {
      renderTree(container, node.children, depth + 1, collapsedSet);
    }
  }
}

// ── Controller state ──

let currentBatches = new Map<string, ResolvedBatch>();
const committingBatches = new Set<string>();
let pollHandle = 0;
let pillEl: HTMLDivElement | null = null;
let collapsedNodes = new Set<BlockNode>();
let focusedBatchIndex = 0;
let bulkConfirmArmed = false;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = styles;
  document.head.appendChild(el);
}

function mountPill(): void {
  if (document.getElementById(PILL_ID)) return;
  const pill = document.createElement("div");
  pill.id = PILL_ID;
  pill.hidden = true;
  pill.addEventListener("click", handlePillClick);
  document.body.appendChild(pill);
  pillEl = pill;
}

function createConfirmButton(
  label: string,
  confirmLabel: string,
  className: string,
  onConfirm: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = label;
  let armed = false;
  let timer = 0;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (armed) {
      armed = false;
      bulkConfirmArmed = false;
      clearTimeout(timer);
      onConfirm();
      return;
    }
    armed = true;
    bulkConfirmArmed = true;
    btn.textContent = confirmLabel;
    btn.classList.add("dg-mcp-pill-bulk-btn--confirm");
    timer = window.setTimeout(() => {
      armed = false;
      bulkConfirmArmed = false;
      btn.textContent = label;
      btn.classList.remove("dg-mcp-pill-bulk-btn--confirm");
    }, 3000);
  });

  return btn;
}

async function handleBulkAction(resolution: "approved" | "rejected"): Promise<void> {
  const batchIds = Array.from(currentBatches.keys());
  for (const batchId of batchIds) {
    if (resolution === "approved") {
      await handleApprove(batchId);
    } else {
      await handleReject(batchId);
    }
  }
}

function renderPill(): void {
  if (!pillEl) return;
  if (currentBatches.size === 0 && committingBatches.size === 0) {
    pillEl.hidden = true;
    pillEl.innerHTML = "";
    bulkConfirmArmed = false;
    return;
  }
  if (bulkConfirmArmed) return;

  const totalBlocks = Array.from(currentBatches.values())
    .reduce((s, b) => s + b.blockCount, 0);
  const n = currentBatches.size;
  pillEl.hidden = false;

  while (pillEl.firstChild) pillEl.removeChild(pillEl.firstChild);

  const dot = document.createElement("span");
  dot.className = "dg-mcp-pill-dot";
  pillEl.appendChild(dot);

  const label = document.createTextNode(
    `${n} write${n === 1 ? "" : "s"}, ${totalBlocks} blocks`,
  );
  pillEl.appendChild(label);

  if (n > 1) {
    const nav = document.createElement("span");
    nav.className = "dg-mcp-pill-nav";

    const up = document.createElement("button");
    up.className = "dg-mcp-pill-nav-btn";
    up.textContent = "\u25B2";
    up.title = "Previous write";
    up.addEventListener("click", (e) => { e.stopPropagation(); navigateBatch(-1); });

    const down = document.createElement("button");
    down.className = "dg-mcp-pill-nav-btn";
    down.textContent = "\u25BC";
    down.title = "Next write";
    down.addEventListener("click", (e) => { e.stopPropagation(); navigateBatch(1); });

    nav.appendChild(up);
    nav.appendChild(down);
    pillEl.appendChild(nav);

    const bulk = document.createElement("span");
    bulk.className = "dg-mcp-pill-bulk";

    const approveAll = createConfirmButton(
      "\u2713 All", "Approve all?",
      "dg-mcp-pill-bulk-btn dg-mcp-pill-bulk-btn--approve",
      () => handleBulkAction("approved"),
    );

    const rejectAll = createConfirmButton(
      "\u2717 All", "Reject all?",
      "dg-mcp-pill-bulk-btn dg-mcp-pill-bulk-btn--reject",
      () => handleBulkAction("rejected"),
    );

    bulk.appendChild(approveAll);
    bulk.appendChild(rejectAll);
    pillEl.appendChild(bulk);
  }
}

function navigateBatch(direction: number): void {
  const batches = Array.from(currentBatches.values());
  if (batches.length === 0) return;

  focusedBatchIndex = ((focusedBatchIndex + direction) % batches.length + batches.length) % batches.length;
  const target = batches[focusedBatchIndex];

  revealTarget(target).then(() => {
    renderAllPending();
    requestAnimationFrame(() => {
      const el = document.querySelector(`.${PENDING_CONTAINER_CLASS}[data-batch-id="${target.batchId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function handlePillClick(): void {
  const batches = Array.from(currentBatches.values());
  if (batches.length === 0) return;

  if (batches.length > 1) {
    navigateBatch(0);
    return;
  }

  const existing = document.querySelector(`.${PENDING_CONTAINER_CLASS}`);
  if (existing) {
    existing.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  revealTarget(batches[0]).then(() => {
    renderAllPending();
    requestAnimationFrame(() => {
      document.querySelector(`.${PENDING_CONTAINER_CLASS}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function getCurrentViewUid(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/\/page\/(.+?)(?:$|\/)/);
  return match?.[1] ?? null;
}

function isDescendantOf(childUid: string, ancestorUid: string): boolean {
  let cur = childUid;
  for (let i = 0; i < 50; i++) {
    if (cur === ancestorUid) return true;
    const parent = getParentUid(cur);
    if (!parent) return false;
    cur = parent;
  }
  return false;
}

async function expandBlockChain(uid: string): Promise<boolean> {
  const chain: string[] = [];
  let cur = uid;
  for (let i = 0; i < 50; i++) {
    chain.unshift(cur);
    const parent = getParentUid(cur);
    if (!parent) break;
    cur = parent;
  }

  for (const ancestorUid of chain) {
    await window.roamAlphaAPI.updateBlock({
      block: { uid: ancestorUid, open: true },
    });
  }

  await new Promise((r) => setTimeout(r, 300));
  return !!findBlockContainer(uid);
}

async function revealTarget(batch: ResolvedBatch): Promise<void> {
  if (batch.kind === "block" && findBlockContainer(batch.parentUid)) return;
  if (batch.kind === "page") {
    const visible = !!document.querySelector(
      `.rm-title-display-container[data-page-uid="${batch.parentUid}"]`,
    );
    if (visible) return;
    await window.roamAlphaAPI.ui.mainWindow.openPage({
      page: { uid: batch.parentUid },
    });
    await new Promise((r) => setTimeout(r, 400));
    return;
  }

  const currentViewUid = getCurrentViewUid();
  if (currentViewUid && isDescendantOf(batch.parentUid, currentViewUid)) {
    await expandBlockChain(batch.parentUid);
    return;
  }

  await window.roamAlphaAPI.ui.mainWindow.openPage({
    page: { uid: batch.pageUid },
  });
  await new Promise((r) => setTimeout(r, 400));
  await expandBlockChain(batch.parentUid);
}

function showError(message: string): void {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;bottom:48px;right:16px;z-index:101;padding:8px 14px;" +
    "background:#c23030;color:#fff;border-radius:6px;font-size:13px;" +
    "font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.2);max-width:360px;";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function clearPendingUI(): void {
  document.querySelectorAll(`.${PENDING_CONTAINER_CLASS}`).forEach((el) => el.remove());
}

function renderPendingBatch(batch: ResolvedBatch): void {
  const appendPoint = findAppendPoint(batch);
  if (!appendPoint) return;

  const container = document.createElement("div");
  container.className = PENDING_CONTAINER_CLASS;
  container.dataset.batchId = batch.batchId;

  for (const tree of batch.trees) {
    renderTree(container, tree, 0, collapsedNodes);
  }

  const actionRow = document.createElement("div");
  actionRow.className = "dg-mcp-action-row";

  const approveBtn = document.createElement("button");
  approveBtn.className = "dg-mcp-action-btn dg-mcp-action-btn--approve";
  approveBtn.textContent = "Approve";
  approveBtn.addEventListener("click", () => handleApprove(batch.batchId));

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "dg-mcp-action-btn dg-mcp-action-btn--reject";
  rejectBtn.textContent = "Reject";
  rejectBtn.addEventListener("click", () => handleReject(batch.batchId));

  const spacer = document.createElement("span");
  spacer.className = "dg-mcp-action-spacer";

  const summary = document.createElement("span");
  summary.className = "dg-mcp-action-summary";
  const b = batch.branchCount;
  const bc = batch.blockCount;
  summary.textContent =
    b > 1 ? `${b} branches, ${bc} blocks` : `${bc} block${bc === 1 ? "" : "s"}`;

  actionRow.appendChild(approveBtn);
  actionRow.appendChild(rejectBtn);
  actionRow.appendChild(spacer);
  actionRow.appendChild(summary);
  container.appendChild(actionRow);

  if (appendPoint.classList.contains("rm-block-children")) {
    appendPoint.appendChild(container);
  } else if (appendPoint.classList.contains("rm-block-main")) {
    appendPoint.insertAdjacentElement("afterend", container);
  } else {
    appendPoint.appendChild(container);
  }
}

function renderAllPending(): void {
  clearPendingUI();
  for (const batch of currentBatches.values()) {
    if (committingBatches.has(batch.batchId)) continue;
    renderPendingBatch(batch);
  }
}

async function handleApprove(batchId: string): Promise<void> {
  const batch = currentBatches.get(batchId);
  if (!batch || committingBatches.has(batchId)) return;

  committingBatches.add(batchId);
  document.querySelector(`.${PENDING_CONTAINER_CLASS}[data-batch-id="${batchId}"]`)?.remove();
  renderPill();

  try {
    for (const tree of batch.trees) {
      await createBlockTree(batch.parentUid, tree);
    }

    await window.roamAlphaAPI.updateBlock({
      block: { uid: batch.parentUid, open: true },
    });

    await fetch(`${BRIDGE_URL}/write-visibility/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, resolution: "approved" }),
    });
  } catch (err) {
    console.error("[dg-mcp] Failed to commit blocks:", err);
    const msg = err instanceof Error ? err.message : String(err);
    const isReadOnly = msg.includes("read-only") || msg.includes("permission") || msg.includes("unauthorized");
    showError(
      isReadOnly
        ? "Graph is read-only — cannot write blocks. Switch to an editable graph."
        : `Write failed: ${msg}`,
    );
  }

  currentBatches.delete(batchId);
  committingBatches.delete(batchId);
  renderPill();
}

async function handleReject(batchId: string): Promise<void> {
  const batch = currentBatches.get(batchId);
  if (!batch || committingBatches.has(batchId)) return;

  document.querySelector(`.${PENDING_CONTAINER_CLASS}[data-batch-id="${batchId}"]`)?.remove();

  try {
    await window.roamAlphaAPI.updateBlock({
      block: { uid: batch.parentUid, open: true },
    });

    await fetch(`${BRIDGE_URL}/write-visibility/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, resolution: "rejected" }),
    });
  } catch (err) {
    console.error("[dg-mcp] Failed to reject batch:", err);
  }

  currentBatches.delete(batchId);
  renderPill();
}

async function pollBridge(): Promise<void> {
  if (committingBatches.size > 0) return;

  try {
    const res = await fetch(`${BRIDGE_URL}/write-visibility/current`, {
      headers: { Accept: "application/json" },
    });

    console.log("[dg-mcp] poll status=%d", res.status);

    if (res.status === 204 || res.status === 404) {
      if (currentBatches.size > 0) {
        currentBatches = new Map();
        collapsedNodes = new Set();
        clearPendingUI();
        renderPill();
      }
      return;
    }

    if (!res.ok) return;

    const payload = (await res.json()) as {
      batches?: PendingBatch[];
      currentBatch?: PendingBatch;
    };
    console.log("[dg-mcp] payload:", JSON.stringify(payload).slice(0, 200));

    const batches = Array.isArray(payload?.batches)
      ? payload.batches
      : payload?.currentBatch?.parentUid
        ? [payload.currentBatch]
        : null;
    if (!batches || batches.length === 0) {
      console.log("[dg-mcp] no batches in payload");
      return;
    }

    console.log("[dg-mcp] %d batch(es) found", batches.length);

    const incomingIds = new Set(batches.map((b) => b.batchId));

    for (const id of currentBatches.keys()) {
      if (!incomingIds.has(id) && !committingBatches.has(id)) {
        currentBatches.delete(id);
      }
    }

    let hasNew = false;
    for (const batch of batches) {
      if (currentBatches.has(batch.batchId)) continue;
      if (committingBatches.has(batch.batchId)) continue;
      if (!batch.parentUid) continue;

      const resolved = resolveBatch(batch);
      if (!resolved) {
        console.warn("[dg-mcp] Could not resolve parent %s — not found in graph", batch.parentUid);
        continue;
      }

      console.log("[dg-mcp] resolved %s → %s (%s)", batch.batchId, resolved.parentLabel, resolved.kind);
      currentBatches.set(batch.batchId, resolved);

      for (const tree of resolved.trees) {
        for (const node of tree) {
          if (countNodes(node.children) > 6) {
            collapsedNodes.add(node);
          }
        }
      }

      hasNew = true;
    }

    if (hasNew && currentBatches.size === 1) {
      const firstNew = currentBatches.values().next().value;
      if (firstNew) await revealTarget(firstNew);
    }

    const visibleContainers = document.querySelectorAll(`.${PENDING_CONTAINER_CLASS}`);
    if (hasNew || visibleContainers.length !== currentBatches.size) {
      renderAllPending();
      if (hasNew) {
        requestAnimationFrame(() => {
          document.querySelector(`.${PENDING_CONTAINER_CLASS}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    }

    renderPill();
  } catch (err) {
    console.warn("[dg-mcp] poll failed:", err);
  }
}

// ── Lifecycle ──

const onload = async (_args?: RoamOnloadArgs) => {
  injectStyles();
  mountPill();
  void pollBridge();
  pollHandle = window.setInterval(() => void pollBridge(), POLL_MS);

  window.dgMcpWriteLocator = {
    getState: () => ({ currentBatches: Object.fromEntries(currentBatches), committingBatches: Array.from(committingBatches) }),
    refresh: () => pollBridge(),
  };

  console.info("[dg-team-mcp] Write locator loaded (multi-batch)");
};

const onunload = () => {
  if (pollHandle) window.clearInterval(pollHandle);
  pollHandle = 0;
  clearPendingUI();
  pillEl?.remove();
  pillEl = null;
  document.getElementById(STYLE_ID)?.remove();
  currentBatches = new Map();
  collapsedNodes = new Set();
  delete window.dgMcpWriteLocator;
};

export default { onload, onunload };
