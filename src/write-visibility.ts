import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const DEFAULT_WRITE_VISIBILITY_PORT = 3597;
export const WRITE_VISIBILITY_CURRENT_PATH = "/write-visibility/current";
export const WRITE_VISIBILITY_CLEAR_PATH = "/write-visibility/clear";
export const WRITE_VISIBILITY_HEALTH_PATH = "/write-visibility/health";
export const WRITE_VISIBILITY_PROPOSE_PATH = "/write-visibility/propose";
export const WRITE_VISIBILITY_STATUS_PATH = "/write-visibility/status";
export const WRITE_VISIBILITY_BATCHES_PATH = "/write-visibility/batches";
export const WRITE_VISIBILITY_SERVICE_NAME = "dg-team-mcp-write-visibility";
export const WRITE_VISIBILITY_SERVICE_VERSION = "1";

export type ProposedWriteBranch = {
  label?: string;
  markdown: string;
};

export type PendingWriteBatch = {
  batchId: string;
  blockCount: number;
  branchCount: number;
  createdAt: string;
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writes: ProposedWriteBranch[];
};

export type BatchResolution = {
  batchId: string;
  parentUid: string;
  resolution: "approved" | "rejected";
  resolvedAt: string;
};

export type WriteVisibilityBridgeRole =
  | "unstarted"
  | "starting"
  | "owner"
  | "client"
  | "unavailable";

export type WriteVisibilityBridgeUnavailableReason =
  | "bridge_invalid_response"
  | "bridge_request_failed"
  | "bridge_unreachable"
  | "not_started"
  | "port_occupied_by_non_bridge";

export type WriteVisibilityBridgeHealth = {
  ok: true;
  cwd: string;
  instanceId: string;
  pendingCount: number;
  pid: number;
  port: number;
  role: "owner";
  service: typeof WRITE_VISIBILITY_SERVICE_NAME;
  startedAt: string;
  version: typeof WRITE_VISIBILITY_SERVICE_VERSION;
  owner: {
    cwd: string;
    instanceId: string;
    pid: number;
    port: number;
    startedAt: string;
  };
};

export type WriteVisibilityBridgeSnapshot = {
  bridgeUrl: string;
  cwd: string;
  instanceId: string;
  pendingCount: number;
  pid: number;
  port: number;
  role: WriteVisibilityBridgeRole;
  service: typeof WRITE_VISIBILITY_SERVICE_NAME;
  startedAt: string;
  unavailableMessage?: string;
  unavailableReason?: WriteVisibilityBridgeUnavailableReason;
  version: typeof WRITE_VISIBILITY_SERVICE_VERSION;
  owner?: WriteVisibilityBridgeHealth;
};

export type PendingWriteStatus =
  | {
      status: "pending_in_roam";
      batches: PendingWriteBatch[];
      bridge: WriteVisibilityBridgeSnapshot;
    }
  | {
      status: "resolved";
      batchId: string;
      parentUid: string;
      resolution: "approved" | "rejected";
      resolvedAt: string;
      bridge: WriteVisibilityBridgeSnapshot;
    }
  | {
      status: "mismatch";
      pendingBatchIds: string[];
      requestedBatchId: string;
      bridge: WriteVisibilityBridgeSnapshot;
    }
  | {
      status: "empty";
      batches: [];
      pendingBatchIds?: string[];
      requestedBatchId?: string;
      bridge: WriteVisibilityBridgeSnapshot;
    };

export type ProposePendingWriteBatchResult = {
  batch: PendingWriteBatch;
  bridge: WriteVisibilityBridgeSnapshot;
  storedVia: "local_owner" | "forwarded_to_owner";
};

export type ClearPendingWriteBatchResult = {
  cleared: boolean;
  clearedBatch: PendingWriteBatch | null;
  bridge: WriteVisibilityBridgeSnapshot;
  error?: string;
  resolution?: "approved" | "rejected" | null;
};

export class WriteVisibilityBridgeError extends Error {
  attemptedUrl: string;
  bridge?: WriteVisibilityBridgeSnapshot;
  reason: WriteVisibilityBridgeUnavailableReason;

  constructor({
    attemptedUrl,
    bridge,
    message,
    reason,
  }: {
    attemptedUrl: string;
    bridge?: WriteVisibilityBridgeSnapshot;
    message: string;
    reason: WriteVisibilityBridgeUnavailableReason;
  }) {
    super(message);
    this.name = "WriteVisibilityBridgeError";
    this.attemptedUrl = attemptedUrl;
    this.bridge = bridge;
    this.reason = reason;
  }
}

export type WriteVisibilityService = {
  clear: (
    batchId?: string,
    resolution?: "approved" | "rejected",
  ) => Promise<ClearPendingWriteBatchResult>;
  getSnapshot: () => WriteVisibilityBridgeSnapshot;
  getStatus: (batchId?: string) => Promise<PendingWriteStatus>;
  propose: (input: {
    graph?: string;
    graphNickname?: string;
    parentUid: string;
    writes: ProposedWriteBranch[];
  }) => Promise<ProposePendingWriteBatchResult>;
  start: (options?: { port?: number }) => Promise<WriteVisibilityBridgeSnapshot>;
  stop: () => Promise<void>;
};

type Logger = Pick<Console, "error">;

type CreateWriteVisibilityServiceOptions = {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  cwd?: string;
  pid?: number;
  startedAt?: string;
  instanceId?: string;
};

type VerifyBridgeResult =
  | { ok: true; health: WriteVisibilityBridgeHealth }
  | {
      ok: false;
      message: string;
      reason: WriteVisibilityBridgeUnavailableReason;
    };

const MAX_RESOLUTIONS = 50;
const REQUEST_TIMEOUT_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bridgeBaseUrl = (port: number) => `http://127.0.0.1:${port}`;

const bridgeUrl = (port: number, path: string) => `${bridgeBaseUrl(port)}${path}`;

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) => {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
};

const writeNoContent = (response: ServerResponse) => {
  response.writeHead(204, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
  });
  response.end();
};

const countMarkdownBlocks = (markdown: string) => {
  const bulletCount = markdown
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+/.test(line))
    .length;
  return Math.max(1, bulletCount);
};

const createInstanceId = () =>
  `wvb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const createBatchId = () =>
  `pwb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isBridgeHealth = (
  value: unknown,
): value is WriteVisibilityBridgeHealth => {
  if (!isRecord(value)) return false;
  return value.ok === true &&
    value.service === WRITE_VISIBILITY_SERVICE_NAME &&
    value.version === WRITE_VISIBILITY_SERVICE_VERSION &&
    value.role === "owner" &&
    typeof value.pid === "number" &&
    typeof value.cwd === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.pendingCount === "number" &&
    typeof value.port === "number";
};

const parseProposeBody = (body: unknown) => {
  if (!isRecord(body)) return null;
  if (typeof body.parentUid !== "string") return null;
  if (!Array.isArray(body.writes) || body.writes.length === 0) return null;

  const writes: ProposedWriteBranch[] = [];
  for (const write of body.writes) {
    if (!isRecord(write) || typeof write.markdown !== "string") {
      return null;
    }
    writes.push({
      label: typeof write.label === "string" ? write.label : undefined,
      markdown: write.markdown,
    });
  }

  return {
    graph: typeof body.graph === "string" ? body.graph : undefined,
    graphNickname:
      typeof body.graphNickname === "string" ? body.graphNickname : undefined,
    parentUid: body.parentUid,
    writes,
  };
};

const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const readJsonResponse = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const createWriteVisibilityService = ({
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  instanceId = createInstanceId(),
  logger = console,
  pid = process.pid,
  startedAt = new Date().toISOString(),
}: CreateWriteVisibilityServiceOptions = {}): WriteVisibilityService => {
  const pendingBatches = new Map<string, PendingWriteBatch>();
  const recentResolutions = new Map<string, BatchResolution>();

  let ownerHealth: WriteVisibilityBridgeHealth | undefined;
  let port = DEFAULT_WRITE_VISIBILITY_PORT;
  let role: WriteVisibilityBridgeRole = "unstarted";
  let server: Server | undefined;
  let startupPromise: Promise<WriteVisibilityBridgeSnapshot> | undefined;
  let unavailableMessage: string | undefined;
  let unavailableReason: WriteVisibilityBridgeUnavailableReason | undefined;

  const snapshot = (): WriteVisibilityBridgeSnapshot => ({
    bridgeUrl: bridgeBaseUrl(port),
    cwd,
    instanceId,
    pendingCount: role === "owner" ? pendingBatches.size : 0,
    pid,
    port,
    role,
    service: WRITE_VISIBILITY_SERVICE_NAME,
    startedAt,
    unavailableMessage,
    unavailableReason,
    version: WRITE_VISIBILITY_SERVICE_VERSION,
    owner: ownerHealth,
  });

  const healthPayload = (): WriteVisibilityBridgeHealth => {
    const owner = {
      cwd,
      instanceId,
      pid,
      port,
      startedAt,
    };

    return {
      ok: true,
      cwd,
      instanceId,
      owner,
      pendingCount: pendingBatches.size,
      pid,
      port,
      role: "owner",
      service: WRITE_VISIBILITY_SERVICE_NAME,
      startedAt,
      version: WRITE_VISIBILITY_SERVICE_VERSION,
    };
  };

  const recordResolution = (
    batch: PendingWriteBatch,
    resolution: "approved" | "rejected",
  ) => {
    if (recentResolutions.size >= MAX_RESOLUTIONS) {
      const oldest = recentResolutions.keys().next().value;
      if (oldest) recentResolutions.delete(oldest);
    }
    recentResolutions.set(batch.batchId, {
      batchId: batch.batchId,
      parentUid: batch.parentUid,
      resolution,
      resolvedAt: new Date().toISOString(),
    });
  };

  const getPendingBatchesLocal = (): PendingWriteBatch[] =>
    Array.from(pendingBatches.values());

  const getResolutionLocal = (batchId: string): BatchResolution | undefined =>
    recentResolutions.get(batchId);

  const clearPendingWriteBatchLocal = (
    batchId?: string,
    resolution?: "approved" | "rejected",
  ): PendingWriteBatch | null => {
    if (pendingBatches.size === 0) {
      return null;
    }

    if (batchId) {
      const batch = pendingBatches.get(batchId);
      if (!batch) return null;
      pendingBatches.delete(batchId);
      if (resolution) recordResolution(batch, resolution);
      return batch;
    }

    const first = pendingBatches.values().next().value;
    pendingBatches.clear();
    if (first && resolution) recordResolution(first, resolution);
    return first ?? null;
  };

  const setPendingWriteBatchLocal = ({
    graph,
    graphNickname,
    parentUid,
    writes,
  }: {
    graph?: string;
    graphNickname?: string;
    parentUid: string;
    writes: ProposedWriteBranch[];
  }) => {
    const batch: PendingWriteBatch = {
      batchId: createBatchId(),
      blockCount: writes.reduce(
        (sum, write) => sum + countMarkdownBlocks(write.markdown),
        0,
      ),
      branchCount: writes.length,
      createdAt: new Date().toISOString(),
      graph,
      graphNickname,
      parentUid,
      writes,
    };

    pendingBatches.set(batch.batchId, batch);
    return batch;
  };

  const statusPayload = (batchId?: string): PendingWriteStatus => {
    const batches = getPendingBatchesLocal();
    const bridge = snapshot();

    if (batchId) {
      const match = batches.find((batch) => batch.batchId === batchId);
      if (match) {
        return {
          status: "pending_in_roam",
          batches: [match],
          bridge,
        };
      }

      const resolution = getResolutionLocal(batchId);
      if (resolution) {
        return {
          status: "resolved",
          resolution: resolution.resolution,
          resolvedAt: resolution.resolvedAt,
          batchId: resolution.batchId,
          parentUid: resolution.parentUid,
          bridge,
        };
      }

      if (batches.length > 0) {
        return {
          status: "mismatch",
          pendingBatchIds: batches.map((batch) => batch.batchId),
          requestedBatchId: batchId,
          bridge,
        };
      }

      return {
        status: "empty",
        batches: [],
        pendingBatchIds: [],
        requestedBatchId: batchId,
        bridge,
      };
    }

    if (batches.length === 0) {
      return {
        status: "empty",
        batches: [],
        bridge,
      };
    }

    return {
      status: "pending_in_roam",
      batches,
      bridge,
    };
  };

  const bridgeUnavailableError = ({
    attemptedUrl,
    message,
    reason,
  }: {
    attemptedUrl: string;
    message?: string;
    reason?: WriteVisibilityBridgeUnavailableReason;
  }) =>
    new WriteVisibilityBridgeError({
      attemptedUrl,
      bridge: snapshot(),
      message: message ??
        `The Roam write locator bridge is unavailable at ${attemptedUrl}.`,
      reason: reason ?? unavailableReason ?? "bridge_unreachable",
    });

  const requestOwnerJson = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { allowErrorStatus?: boolean } = {},
  ) => {
    const attemptedUrl = bridgeUrl(port, path);

    if (role === "unavailable") {
      throw bridgeUnavailableError({
        attemptedUrl,
        message:
          `The Roam write locator bridge is unavailable at ${attemptedUrl}: ` +
          (unavailableMessage ?? "bridge startup failed."),
      });
    }

    try {
      const response = await fetchWithTimeout(fetchImpl, attemptedUrl, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const payload = await readJsonResponse(response);
      if (!response.ok && !options.allowErrorStatus) {
        const message = isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Bridge request failed with HTTP ${response.status}.`;
        throw bridgeUnavailableError({
          attemptedUrl,
          message:
            `The Roam write locator bridge request failed at ${attemptedUrl}: ` +
            message,
          reason: "bridge_request_failed",
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof WriteVisibilityBridgeError) throw error;
      throw bridgeUnavailableError({
        attemptedUrl,
        message:
          `The Roam write locator bridge is unreachable at ${attemptedUrl}: ` +
          describeError(error),
        reason: "bridge_unreachable",
      });
    }
  };

  const verifyExistingBridge = async (
    existingPort: number,
  ): Promise<VerifyBridgeResult> => {
    const attemptedUrl = bridgeUrl(existingPort, WRITE_VISIBILITY_HEALTH_PATH);
    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetchWithTimeout(fetchImpl, attemptedUrl, {
          headers: { Accept: "application/json" },
        });
        const payload = await readJsonResponse(response);

        if (response.ok && isBridgeHealth(payload)) {
          return { ok: true, health: payload };
        }

        return {
          ok: false,
          reason: "port_occupied_by_non_bridge",
          message:
            `Port ${existingPort} is in use, but ${attemptedUrl} did not ` +
            `return ${WRITE_VISIBILITY_SERVICE_NAME} health.`,
        };
      } catch (error) {
        lastError = error;
        await sleep(50);
      }
    }

    return {
      ok: false,
      reason: "bridge_unreachable",
      message:
        `Port ${existingPort} is in use, but the write locator bridge health ` +
        `endpoint is unreachable at ${attemptedUrl}: ${describeError(lastError)}`,
    };
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (!request.url) {
      writeNoContent(response);
      return;
    }

    if (request.method === "OPTIONS") {
      writeNoContent(response);
      return;
    }

    const url = new URL(request.url, bridgeBaseUrl(port));

    if (
      request.method === "GET" &&
      url.pathname === WRITE_VISIBILITY_HEALTH_PATH
    ) {
      writeJson(response, 200, healthPayload());
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === WRITE_VISIBILITY_CURRENT_PATH
    ) {
      if (pendingBatches.size === 0) {
        writeNoContent(response);
        return;
      }

      writeJson(response, 200, {
        batches: Array.from(pendingBatches.values()),
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === WRITE_VISIBILITY_BATCHES_PATH
    ) {
      writeJson(response, 200, {
        batches: Array.from(pendingBatches.values()),
        bridge: snapshot(),
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === WRITE_VISIBILITY_STATUS_PATH
    ) {
      const batchId = url.searchParams.get("batchId") ?? undefined;
      writeJson(response, 200, statusPayload(batchId));
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === WRITE_VISIBILITY_PROPOSE_PATH
    ) {
      const body = await readRequestBody(request);
      const input = parseProposeBody(body);
      if (!input) {
        writeJson(response, 400, {
          ok: false,
          error:
            "Invalid proposed write payload. Expected parentUid and non-empty writes[].",
        });
        return;
      }

      const batch = setPendingWriteBatchLocal(input);
      writeJson(response, 200, {
        ok: true,
        batch,
        bridge: snapshot(),
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === WRITE_VISIBILITY_CLEAR_PATH
    ) {
      const body = await readRequestBody(request);
      const batchId =
        isRecord(body) && typeof body.batchId === "string"
          ? body.batchId
          : undefined;
      const resolution =
        isRecord(body) &&
        (body.resolution === "approved" || body.resolution === "rejected")
          ? body.resolution
          : undefined;

      const cleared = clearPendingWriteBatchLocal(batchId, resolution);
      if (!cleared) {
        writeJson(response, 404, {
          cleared: false,
          bridge: snapshot(),
          error: batchId
            ? `No pending write batch matched batchId ${batchId}.`
            : "No pending write batches to clear.",
        });
        return;
      }

      writeJson(response, 200, {
        cleared: true,
        clearedBatch: cleared,
        bridge: snapshot(),
        resolution: resolution ?? null,
      });
      return;
    }

    writeNoContent(response);
  };

  const start = async ({
    port: requestedPort = DEFAULT_WRITE_VISIBILITY_PORT,
  }: { port?: number } = {}) => {
    if (startupPromise) return startupPromise;
    if (role !== "unstarted") return snapshot();

    port = requestedPort;
    role = "starting";

    startupPromise = new Promise<WriteVisibilityBridgeSnapshot>((resolve) => {
      const bridgeServer = createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          logger.error("[write-visibility] Bridge request error:", error);
          if (!response.headersSent) {
            writeJson(response, 500, {
              ok: false,
              error: describeError(error),
            });
          } else {
            response.end();
          }
        });
      });

      let settled = false;
      const settle = () => {
        settled = true;
        resolve(snapshot());
      };

      bridgeServer.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) {
          logger.error("[write-visibility] Bridge error:", error);
          return;
        }

        if (error.code !== "EADDRINUSE") {
          role = "unavailable";
          unavailableReason = "bridge_unreachable";
          unavailableMessage =
            `Could not start write locator bridge on port ${port}: ` +
            describeError(error);
          logger.error(`[write-visibility] ${unavailableMessage}`);
          settle();
          return;
        }

        verifyExistingBridge(port)
          .then((result) => {
            if (result.ok) {
              role = "client";
              ownerHealth = result.health;
              unavailableMessage = undefined;
              unavailableReason = undefined;
              logger.error(
                "[write-visibility] Bridge client: forwarding proposed " +
                  `writes to owner pid=${result.health.pid} cwd=${result.health.cwd} ` +
                  `at ${bridgeBaseUrl(port)}.`,
              );
              settle();
              return;
            }

            role = "unavailable";
            unavailableReason = result.reason;
            unavailableMessage = result.message;
            logger.error(`[write-visibility] ${result.message}`);
            settle();
          })
          .catch((verificationError) => {
            role = "unavailable";
            unavailableReason = "bridge_unreachable";
            unavailableMessage =
              `Port ${port} is in use, but bridge verification failed: ` +
              describeError(verificationError);
            logger.error(`[write-visibility] ${unavailableMessage}`);
            settle();
          });
      });

      bridgeServer.listen(port, "127.0.0.1", () => {
        const address = bridgeServer.address();
        if (typeof address === "object" && address?.port) {
          port = address.port;
        }

        server = bridgeServer;
        role = "owner";
        ownerHealth = undefined;
        unavailableMessage = undefined;
        unavailableReason = undefined;
        logger.error(
          "[write-visibility] Bridge owner: listening at " +
            `${bridgeUrl(port, WRITE_VISIBILITY_CURRENT_PATH)} ` +
            `pid=${pid} cwd=${cwd}.`,
        );
        settle();
      });
    });

    return startupPromise;
  };

  const ensureStarted = async () => {
    if (role === "unstarted") {
      await start({ port });
    } else if (role === "starting" && startupPromise) {
      await startupPromise;
    }
  };

  const ensureClientCanForward = async (path: string) => {
    await ensureStarted();

    if (role === "client") return;
    if (role === "unavailable") {
      throw bridgeUnavailableError({
        attemptedUrl: bridgeUrl(port, path),
        message:
          `The Roam write locator bridge is unavailable at ` +
          `${bridgeUrl(port, path)}: ${unavailableMessage ?? "unknown error"}`,
      });
    }

    throw bridgeUnavailableError({
      attemptedUrl: bridgeUrl(port, path),
      message:
        `The Roam write locator bridge is not started for forwarding at ` +
        `${bridgeUrl(port, path)}.`,
      reason: "not_started",
    });
  };

  const propose: WriteVisibilityService["propose"] = async (input) => {
    await ensureStarted();

    if (role === "owner") {
      const batch = setPendingWriteBatchLocal(input);
      return {
        batch,
        bridge: snapshot(),
        storedVia: "local_owner",
      };
    }

    await ensureClientCanForward(WRITE_VISIBILITY_PROPOSE_PATH);
    const payload = await requestOwnerJson(
      "POST",
      WRITE_VISIBILITY_PROPOSE_PATH,
      input,
    );

    if (
      !isRecord(payload) ||
      payload.ok !== true ||
      !isRecord(payload.batch)
    ) {
      throw bridgeUnavailableError({
        attemptedUrl: bridgeUrl(port, WRITE_VISIBILITY_PROPOSE_PATH),
        message:
          `The Roam write locator bridge returned an invalid response from ` +
          `${bridgeUrl(port, WRITE_VISIBILITY_PROPOSE_PATH)}.`,
        reason: "bridge_invalid_response",
      });
    }

    return {
      batch: payload.batch as PendingWriteBatch,
      bridge: isRecord(payload.bridge)
        ? payload.bridge as WriteVisibilityBridgeSnapshot
        : snapshot(),
      storedVia: "forwarded_to_owner",
    };
  };

  const getStatus: WriteVisibilityService["getStatus"] = async (batchId) => {
    await ensureStarted();

    if (role === "owner") {
      return statusPayload(batchId);
    }

    await ensureClientCanForward(WRITE_VISIBILITY_STATUS_PATH);
    const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : "";
    const payload = await requestOwnerJson(
      "GET",
      `${WRITE_VISIBILITY_STATUS_PATH}${query}`,
    );

    if (!isRecord(payload) || typeof payload.status !== "string") {
      throw bridgeUnavailableError({
        attemptedUrl: bridgeUrl(port, `${WRITE_VISIBILITY_STATUS_PATH}${query}`),
        message:
          `The Roam write locator bridge returned an invalid status response ` +
          `from ${bridgeUrl(port, `${WRITE_VISIBILITY_STATUS_PATH}${query}`)}.`,
        reason: "bridge_invalid_response",
      });
    }

    return payload as PendingWriteStatus;
  };

  const clear: WriteVisibilityService["clear"] = async (batchId, resolution) => {
    await ensureStarted();

    if (role === "owner") {
      const cleared = clearPendingWriteBatchLocal(batchId, resolution);
      return {
        cleared: Boolean(cleared),
        clearedBatch: cleared,
        bridge: snapshot(),
        error: cleared
          ? undefined
          : batchId
            ? `No pending write batch matched batchId ${batchId}.`
            : "No pending write batches to clear.",
        resolution: resolution ?? null,
      };
    }

    await ensureClientCanForward(WRITE_VISIBILITY_CLEAR_PATH);
    const payload = await requestOwnerJson(
      "POST",
      WRITE_VISIBILITY_CLEAR_PATH,
      { batchId, resolution },
      { allowErrorStatus: true },
    );

    if (!isRecord(payload) || typeof payload.cleared !== "boolean") {
      throw bridgeUnavailableError({
        attemptedUrl: bridgeUrl(port, WRITE_VISIBILITY_CLEAR_PATH),
        message:
          `The Roam write locator bridge returned an invalid clear response ` +
          `from ${bridgeUrl(port, WRITE_VISIBILITY_CLEAR_PATH)}.`,
        reason: "bridge_invalid_response",
      });
    }

    return payload as ClearPendingWriteBatchResult;
  };

  const stop = async () => {
    const activeServer = server;
    server = undefined;
    startupPromise = undefined;
    ownerHealth = undefined;
    pendingBatches.clear();
    recentResolutions.clear();
    role = "unstarted";
    unavailableMessage = undefined;
    unavailableReason = undefined;

    if (!activeServer) return;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };

  return {
    clear,
    getSnapshot: snapshot,
    getStatus,
    propose,
    start,
    stop,
  };
};

export const defaultWriteVisibilityService = createWriteVisibilityService();

export const startWriteVisibilityBridge = (options?: { port?: number }) =>
  defaultWriteVisibilityService.start(options);

export const setPendingWriteBatch = (input: {
  graph?: string;
  graphNickname?: string;
  parentUid: string;
  writes: ProposedWriteBranch[];
}) => defaultWriteVisibilityService.propose(input);

export const getPendingWriteBatchStatus = (batchId?: string) =>
  defaultWriteVisibilityService.getStatus(batchId);

export const clearPendingWriteBatch = (
  batchId?: string,
  resolution?: "approved" | "rejected",
) => defaultWriteVisibilityService.clear(batchId, resolution);
