import type {
  EventFrame,
  GatewayConnectOptions,
  GatewayGapInfo,
  GatewayStatus,
} from "@/lib/gateway/GatewayClient";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import {
  buildAgentMainSessionKey,
  parseAgentIdFromSessionKey,
} from "@/lib/gateway/GatewayClient";
import {
  fetchCustomRuntimeJson,
  normalizeCustomBaseUrl,
  requestCustomRuntime,
} from "@/lib/runtime/custom/http";
import {
  buildAgentHandoffInstruction,
  buildDirectedAgentMessageInstruction,
} from "@/lib/runtime/agentMessaging";
import type {
  RuntimeCapability,
  RuntimeEvent,
  RuntimeProvider,
  RuntimeProviderId,
} from "@/lib/runtime/types";

const CUSTOM_RUNTIME_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
  "agents",
  "sessions",
  "chat",
  "agent-messages",
  "agent-handoffs",
  "models",
  "agent-roles",
]);

type CustomRuntimeStateResponse = {
  profileName?: string | null;
  registry_profile?: string | null;
  active?: Record<string, unknown> | null;
  profile?: string | null;
  identity?: {
    name?: string | null;
    role?: string | null;
    lane?: string | null;
    model_id?: string | null;
  } | null;
  runtime?: {
    name?: string | null;
    version?: string | null;
    vendor?: string | null;
    status?: string | null;
    active_model?: string | null;
    governance?: string | null;
  } | null;
  [key: string]: unknown;
};

type CustomRuntimeRegistryResponse = {
  models?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type CustomRuntimeHealthResponse = {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
};

type SyntheticAgent = {
  id: string;
  name: string;
  role: string | null;
};

type SessionMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

type SessionRecord = {
  sessionKey: string;
  agentId: string;
  role: string | null;
  model: string | null;
  updatedAt: number | null;
  messages: SessionMessage[];
};

type ActiveRunRecord = {
  runId: string;
  sessionKey: string;
  controller: AbortController;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const titleCase = (value: string): string =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const resolveRouteProfile = (state: CustomRuntimeStateResponse | null): string | null => {
  if (!state) return null;
  if (typeof state.profileName === "string" && state.profileName.trim()) return state.profileName.trim();
  if (typeof state.registry_profile === "string" && state.registry_profile.trim()) {
    return state.registry_profile.trim();
  }
  if (typeof state.profile === "string" && state.profile.trim()) return state.profile.trim();
  return null;
};

const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
};

const resolveAssistantTextFromResponse = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = isRecord(first.message) ? first.message : null;
  const direct = extractContentText(message?.content);
  if (direct) return direct;
  const text = extractContentText(first.text);
  return text || null;
};

const isAbortLikeError = (error: unknown, controller?: AbortController | null): boolean => {
  if (controller?.signal.aborted) return true;
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
};

const normalizeModelChoices = (registry: CustomRuntimeRegistryResponse | null): string[] => {
  if (!registry || !isRecord(registry.models)) return [];
  return Object.keys(registry.models).map((value) => value.trim()).filter(Boolean);
};

const resolveOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const resolveDefaultModelId = (
  state: CustomRuntimeStateResponse | null,
  modelChoices: string[]
): string | null => {
  return (
    resolveOptionalString(state?.identity?.model_id) ??
    resolveOptionalString(state?.runtime?.active_model) ??
    modelChoices[0] ??
    null
  );
};

const buildIdentityAgent = (
  state: CustomRuntimeStateResponse | null,
  runtimeName: string
): SyntheticAgent | null => {
  const name = resolveOptionalString(state?.identity?.name);
  const role = resolveOptionalString(state?.identity?.role) ?? "assistant";
  const lane = resolveOptionalString(state?.identity?.lane);
  if (!name && !lane && !role) return null;
  return {
    id: lane ?? role ?? "main",
    name: name ?? titleCase(lane ?? runtimeName),
    role,
  };
};

const buildChatFailureMessage = (
  statusCode: number,
  responseText: string,
  health: CustomRuntimeHealthResponse | null
): string => {
  const trimmed = responseText.trim();
  if (trimmed) return trimmed;
  const healthStatus = resolveOptionalString(health?.status);
  if (healthStatus) {
    return `Custom runtime chat failed (${statusCode}). Runtime health is ${healthStatus}.`;
  }
  return `Custom runtime chat failed (${statusCode}).`;
};

const buildSyntheticAgents = (
  state: CustomRuntimeStateResponse | null,
  runtimeName: string
): SyntheticAgent[] => {
  const active = isRecord(state?.active) ? state.active : null;
  if (active) {
    const agents: SyntheticAgent[] = [];
    for (const [roleKey, value] of Object.entries(active)) {
      const role = roleKey.trim();
      if (!role) continue;
      const hasModels =
        (typeof value === "string" && value.trim()) ||
        (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim()));
      if (!hasModels) continue;
      agents.push({
        id: role,
        name: titleCase(role),
        role,
      });
    }
    if (agents.length > 0) {
      return agents;
    }
  }
  const identityAgent = buildIdentityAgent(state, runtimeName);
  if (identityAgent) {
    return [identityAgent];
  }
  return [
    {
      id: "main",
      name: runtimeName,
      role: "assistant",
    },
  ];
};

/*
 * Operations feed ("fmi-ops/1")
 *
 * A Custom Runtime may advertise, in /state.capabilities, a read-only feed of the work its
 * backend has recorded (the Insurance Multi-Agent Operations Lab gateway does). When it does,
 * the provider follows that feed and replays it as the lifecycle and tool agent frames the
 * office already understands, so desks animate from real recorded work without anyone
 * chatting. The feed is only read (GET /ops/agents, GET /ops/events): it never sends chat,
 * never runs a model and never starts or decides anything. Runtimes that do not advertise the
 * feed (such as the Claims Adapter) are not polled at all.
 */
export const OPS_FEED_PROTOCOL = "fmi-ops/1";
export const OPS_FEED_SOURCE_KEY = "custom-runtime:ops-feed";
/** Only these agents' recorded workflow steps are animated. */
export const OPS_FEED_AGENT_IDS: ReadonlySet<string> = new Set([
  "business-operations",
  "risk-compliance",
]);
const OPS_FEED_DEFAULT_EVENTS_PATH = "/ops/events";
const OPS_FEED_DEFAULT_AGENTS_PATH = "/ops/agents";
const OPS_FEED_WAIT_SECONDS = 20; // bounded long poll; the gateway caps it at 25 s
const OPS_FEED_PAGE_LIMIT = 200;
const OPS_FEED_INITIAL_BACKOFF_MS = 1_000;
const OPS_FEED_MAX_BACKOFF_MS = 30_000;
const OPS_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Re-assert an open run this long after the office's fleet refresh has read the agent's history. */
const OPS_REASSERT_DELAY_MS = 750;
/** Only history reads this soon after a fleet refresh (agents.list) belong to that refresh. */
const OPS_REASSERT_WINDOW_MS = 30_000;

export type OpsFeedCapability = { eventsPath: string; agentsPath: string };

export type OpsFeedEvent = {
  seq: number;
  kind: string;
  agentId?: string | null;
  runId?: string | null;
  phase?: string | null;
  data?: Record<string, unknown> | null;
};

const OPS_PROVENANCE_LABELS: Record<string, string> = {
  model: "model output",
  incomplete: "model output, reported incomplete",
  fallback: "DETERMINISTIC FALLBACK (not model output)",
  error: "no output (error)",
};

const isOpsFeedPath = (value: unknown): value is string =>
  typeof value === "string" && /^\/[A-Za-z0-9/_-]*$/.test(value);

/** The feed's paths if /state explicitly advertises protocol "fmi-ops/1", otherwise null. */
export const resolveOpsFeedCapability = (state: unknown): OpsFeedCapability | null => {
  const capabilities = isRecord(state) && isRecord(state.capabilities) ? state.capabilities : null;
  if (!capabilities || capabilities.protocol !== OPS_FEED_PROTOCOL) return null;
  return {
    eventsPath: isOpsFeedPath(capabilities.opsEvents)
      ? capabilities.opsEvents
      : OPS_FEED_DEFAULT_EVENTS_PATH,
    agentsPath: isOpsFeedPath(capabilities.opsAgents)
      ? capabilities.opsAgents
      : OPS_FEED_DEFAULT_AGENTS_PATH,
  };
};

/**
 * Frame streams used: "lifecycle" (start/end/error) and "tool" are the office's own vocabulary.
 * "activity" carries no content: the office only marks the agent active and does not change its
 * status (it is dropped for a run that is not the agent's current run). It is sent only on backend
 * evidence that the run is still working, so the office does not treat a long model call as
 * silence (after 120 s without events it re-reads the fleet and would reset the agent to idle).
 */
const opsAgentFrame = (
  runId: string,
  sessionKey: string,
  stream: "lifecycle" | "tool" | "activity",
  data: Record<string, unknown>
): EventFrame => ({
  type: "event",
  event: "agent",
  payload: { runId, sessionKey, stream, data },
});

const opsToolFrame = (
  event: OpsFeedEvent,
  runId: string,
  sessionKey: string,
  name: string,
  args: Record<string, unknown>
): EventFrame =>
  opsAgentFrame(runId, sessionKey, "tool", {
    name: OPS_TOOL_NAME_RE.test(name) ? name : "tool",
    toolCallId: `ops-${event.seq}`,
    phase: "call",
    arguments: args,
  });

/**
 * One feed event -> the agent frames that show it, or none.
 *
 * `openRuns` maps runId -> session key for runs whose start was observed (or seeded from
 * /ops/agents). A run is animated only from its recorded start to its recorded end: no frame is
 * produced for a run that was never seen starting, and a run ends exactly as recorded
 * ("end" only for a completed step; "error" for a failed, incomplete or interrupted one).
 * Human decisions are never turned into frames.
 */
export const translateOpsFeedEvent = (
  event: OpsFeedEvent,
  openRuns: Map<string, string>
): EventFrame[] => {
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  if (!runId) return [];
  const data = isRecord(event.data) ? event.data : {};
  if (event.kind === "agent.started") {
    const agentId = typeof event.agentId === "string" ? event.agentId.trim() : "";
    if (!OPS_FEED_AGENT_IDS.has(agentId) || event.phase !== "start") return [];
    const sessionKey = buildAgentMainSessionKey(agentId, "main");
    openRuns.set(runId, sessionKey);
    return [opsAgentFrame(runId, sessionKey, "lifecycle", { phase: "start" })];
  }
  const sessionKey = openRuns.get(runId);
  if (!sessionKey) return [];
  switch (event.kind) {
    case "agent.model_call":
      // A recorded model round: evidence the agent is working; no content is shown.
      return [opsAgentFrame(runId, sessionKey, "activity", { source: "fmi-ops", kind: "model_call" })];
    case "agent.tool":
      return [
        opsToolFrame(event, runId, sessionKey, String(data.tool ?? "tool"), {
          target: data.target ?? null,
          result: data.code ?? null,
        }),
      ];
    case "agent.finished":
      return [
        opsToolFrame(event, runId, sessionKey, "step_outcome", {
          task: data.task ?? null,
          output: OPS_PROVENANCE_LABELS[String(data.provenance)] ?? "unknown",
        }),
      ];
    case "handoff.consultation_requested":
      return [
        opsToolFrame(event, runId, sessionKey, "handoff", {
          from: "business-operations",
          to: "risk-compliance",
          consultation: "requested",
          questions: data.questions ?? null,
          changesInScope: data.changesInScope ?? null,
        }),
      ];
    case "handoff.consultation_returned":
      return [
        opsToolFrame(event, runId, sessionKey, "handoff", {
          from: "risk-compliance",
          to: "business-operations",
          consultation: "returned",
          outcome: data.outcome ?? null,
          successful: data.successful === true,
        }),
      ];
    case "human.review_requested":
      return [
        opsToolFrame(event, runId, sessionKey, "awaiting_human_review", {
          checkpoint: data.checkpoint ?? null,
          role: data.role ?? null,
        }),
      ];
    case "agent.step_completed":
    case "agent.step_failed":
    case "agent.step_interrupted": {
      const phase = event.phase === "end" ? "end" : event.phase === "error" ? "error" : null;
      if (!phase) return [];
      openRuns.delete(runId);
      return [opsAgentFrame(runId, sessionKey, "lifecycle", { phase })];
    }
    default:
      return [];
  }
};

class OpsFeedProtocolError extends Error {}

const readOpsPayload = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) throw new Error("Operations feed returned a malformed response.");
  if (payload.protocol !== OPS_FEED_PROTOCOL) {
    throw new OpsFeedProtocolError(
      `Operations feed protocol changed (expected ${OPS_FEED_PROTOCOL}).`
    );
  }
  return payload;
};

const readOpsCursor = (payload: Record<string, unknown>): number | null =>
  typeof payload.cursor === "number" && Number.isInteger(payload.cursor) && payload.cursor >= 0
    ? payload.cursor
    : null;

/**
 * Follows the operations feed with bounded long polls. Keeps one cursor for its whole life, so
 * after a dropped connection or a runtime restart it resumes exactly where it stopped; an event
 * at or below the cursor is never delivered twice. Errors back off exponentially (also on 429).
 */
export class OpsFeedSubscription {
  readonly openRuns = new Map<string, string>();
  private stopped = false;
  private started = false;
  private cursor: number | null = null;
  private controller: AbortController | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly options: OpsFeedCapability & {
      request: (pathname: string, signal: AbortSignal) => Promise<unknown>;
      dispatch: (frame: EventFrame) => void;
      waitSeconds?: number;
      initialBackoffMs?: number;
      maxBackoffMs?: number;
      warn?: (message: string, detail?: unknown) => void;
    }
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  get currentCursor(): number | null {
    return this.cursor;
  }

  isRunOpen(runId: string): boolean {
    return this.openRuns.has(runId);
  }

  start(): Promise<void> {
    if (this.started || this.stopped) return Promise.resolve();
    this.started = true;
    return this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wake?.();
    this.wake = null;
    this.openRuns.clear();
  }

  private async loop(): Promise<void> {
    const initialBackoff = this.options.initialBackoffMs ?? OPS_FEED_INITIAL_BACKOFF_MS;
    const maxBackoff = this.options.maxBackoffMs ?? OPS_FEED_MAX_BACKOFF_MS;
    const wait = this.options.waitSeconds ?? OPS_FEED_WAIT_SECONDS;
    let backoff = initialBackoff;
    while (!this.stopped) {
      try {
        if (this.cursor === null) await this.seed();
        if (this.stopped) break;
        const page = readOpsPayload(
          await this.get(
            `${this.options.eventsPath}?after=${this.cursor}&limit=${OPS_FEED_PAGE_LIMIT}&wait=${wait}`
          )
        );
        if (this.stopped) break;
        const events = Array.isArray(page.events) ? page.events : [];
        for (const raw of events) {
          if (!isRecord(raw) || typeof raw.seq !== "number" || typeof raw.kind !== "string") continue;
          if (this.cursor !== null && raw.seq <= this.cursor) continue; // never deliver twice
          this.cursor = raw.seq;
          for (const frame of translateOpsFeedEvent(raw as OpsFeedEvent, this.openRuns)) {
            this.emit(frame);
          }
        }
        const pageCursor = readOpsCursor(page);
        if (pageCursor !== null && this.cursor !== null && pageCursor > this.cursor) {
          this.cursor = pageCursor; // skip past events the feed does not publish
        }
        if (events.length === 0 && this.openRuns.size > 0) await this.reconcileOpenRuns();
        backoff = initialBackoff;
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof OpsFeedProtocolError) {
          this.options.warn?.(error.message);
          this.stop();
          break;
        }
        this.options.warn?.("Operations feed unavailable; retrying.", error);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  /** Start from "now": agents recorded as working right now are shown working; history is not replayed. */
  private async seed(): Promise<void> {
    const payload = readOpsPayload(await this.get(this.options.agentsPath));
    if (this.stopped) return;
    for (const agent of Array.isArray(payload.agents) ? payload.agents : []) {
      const working = this.workingRun(agent);
      if (!working || this.openRuns.has(working.runId)) continue;
      this.openRuns.set(working.runId, working.sessionKey);
      this.emit(opsAgentFrame(working.runId, working.sessionKey, "lifecycle", { phase: "start" }));
    }
    this.cursor = readOpsCursor(payload) ?? 0;
  }

  /**
   * A quiet feed with open runs: confirm each run is still recorded as working. A run whose step
   * stopped without a recorded end (its process died) is shown as an error, not left animating.
   * Skipped when the feed already holds newer events, which are delivered first.
   */
  private async reconcileOpenRuns(): Promise<void> {
    const payload = readOpsPayload(await this.get(this.options.agentsPath));
    if (this.stopped) return;
    const cursor = readOpsCursor(payload);
    if (cursor === null || this.cursor === null || cursor > this.cursor) return;
    const working = new Set<string>();
    for (const agent of Array.isArray(payload.agents) ? payload.agents : []) {
      const run = this.workingRun(agent);
      if (run) working.add(run.runId);
    }
    for (const [runId, sessionKey] of [...this.openRuns]) {
      if (working.has(runId)) {
        // Still recorded as working (running step + runner lock): keep the office from
        // mistaking a long model call for silence.
        this.emit(opsAgentFrame(runId, sessionKey, "activity", { source: "fmi-ops", kind: "still_working" }));
        continue;
      }
      this.openRuns.delete(runId);
      this.emit(opsAgentFrame(runId, sessionKey, "lifecycle", { phase: "error" }));
    }
  }

  /** The open feed run for this session, if any. */
  openRunFor(sessionKey: string): string | null {
    for (const [runId, key] of this.openRuns) {
      if (key === sessionKey) return runId;
    }
    return null;
  }

  /**
   * Show an open run as started again. Used after the office re-reads its fleet: that refresh
   * infers "idle" for any agent without a pending chat reply, which a feed run never has.
   */
  reassertOpenRun(sessionKey: string): boolean {
    const runId = this.openRunFor(sessionKey);
    if (!runId || this.stopped) return false;
    this.emit(opsAgentFrame(runId, sessionKey, "lifecycle", { phase: "start" }));
    return true;
  }

  private workingRun(agent: unknown): { runId: string; sessionKey: string } | null {
    if (!isRecord(agent) || agent.status !== "working") return null;
    const agentId = typeof agent.agentId === "string" ? agent.agentId.trim() : "";
    const runId = typeof agent.runId === "string" ? agent.runId.trim() : "";
    if (!OPS_FEED_AGENT_IDS.has(agentId) || !runId) return null;
    return { runId, sessionKey: buildAgentMainSessionKey(agentId, "main") };
  }

  private emit(frame: EventFrame): void {
    try {
      this.options.dispatch(frame);
    } catch (error) {
      this.options.warn?.("An office event handler failed for an operations feed frame.", error);
    }
  }

  private async get(pathname: string): Promise<unknown> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await this.options.request(pathname, controller.signal);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.wake = null;
        resolve();
      }, ms);
    });
  }
}

export class CustomRuntimeProvider implements RuntimeProvider {
  readonly id: RuntimeProviderId;
  readonly label: string;
  readonly capabilities = CUSTOM_RUNTIME_CAPABILITIES;
  /** Only the model can be configured per session; see callSessionsPatch. */
  readonly supportedSessionSettings: ReadonlySet<"model"> = new Set(["model"] as const);
  readonly metadata;
  private readonly baseUrl: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly activeRunsByRunId = new Map<string, ActiveRunRecord>();
  private readonly activeRunIdBySessionKey = new Map<string, string>();
  private opsFeed: OpsFeedSubscription | null = null;
  private unregisterOpsFeed: (() => void) | null = null;
  /** When the office last re-read its fleet (agents.list), and which runs were re-asserted since. */
  private opsFleetRefreshAt = 0;
  private readonly opsReassertedAt = new Map<string, number>();
  private readonly opsReassertTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly client: GatewayClient,
    runtimeUrl: string,
    options?: {
      id?: Extract<RuntimeProviderId, "custom" | "local" | "hermes3d">;
      label?: string;
      runtimeName?: string;
      vendor?: string | null;
      routeProfile?: string | null;
    }
  ) {
    this.id = options?.id ?? "custom";
    this.label = options?.label ?? "Custom";
    this.baseUrl = normalizeCustomBaseUrl(runtimeUrl);
    this.metadata = {
      id: this.id,
      label: this.label,
      runtimeName: options?.runtimeName ?? `${this.label} Runtime`,
      vendor: options?.vendor ?? null,
      routeProfile: options?.routeProfile ?? this.id,
    };
  }

  connect(options: GatewayConnectOptions): Promise<void> {
    return this.client.connect(options);
  }

  disconnect(): void {
    this.client.disconnect();
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    switch (method) {
      case "agents.list":
        return (await this.callAgentsList()) as T;
      case "sessions.list":
        return (await this.callSessionsList(params)) as T;
      case "status":
        return (await this.callStatus()) as T;
      case "models.list":
        return (await this.callModelsList()) as T;
      case "sessions.preview":
        return (await this.callSessionsPreview(params)) as T;
      case "chat.history":
        return (await this.callChatHistory(params)) as T;
      case "sessions.patch":
        return (await this.callSessionsPatch(params)) as T;
      case "chat.send":
        return (await this.callChatSend(params)) as T;
      case "agents.message":
        return (await this.callAgentsMessage(params)) as T;
      case "agents.handoff":
        return (await this.callAgentsHandoff(params)) as T;
      case "chat.abort":
        return (await this.callChatAbort(params)) as T;
      case "sessions.reset":
        return (await this.callSessionsReset(params)) as T;
      case "agent.wait":
        return (await this.callAgentWait(params)) as T;
      case "exec.approvals.get":
        return ({ file: { agents: {} } } as T);
      case "config.get":
      case "config.patch":
      case "config.set":
        throw new Error(`Custom runtime does not support ${method}.`);
      default:
        throw new Error(`Custom runtime does not implement ${method}.`);
    }
  }

  onStatus(handler: (status: GatewayStatus) => void): () => void {
    return this.client.onStatus(handler);
  }

  onGap(handler: (info: GatewayGapInfo) => void): () => void {
    return this.client.onGap(handler);
  }

  onEvent(handler: (event: EventFrame) => void): () => void {
    return this.client.onEvent(handler);
  }

  onRuntimeEvent(_handler: (event: RuntimeEvent) => void): () => void {
    return () => {};
  }

  async fetchHealth(): Promise<CustomRuntimeHealthResponse> {
    return this.fetchJson<CustomRuntimeHealthResponse>("/health");
  }

  async fetchState(): Promise<CustomRuntimeStateResponse> {
    return this.fetchJson<CustomRuntimeStateResponse>("/state");
  }

  async fetchRegistry(): Promise<CustomRuntimeRegistryResponse> {
    return this.fetchJson<CustomRuntimeRegistryResponse>("/registry");
  }

  async describeRuntime() {
    const [health, state, registry] = await Promise.all([
      this.fetchHealth().catch(() => null),
      this.fetchState().catch(() => null),
      this.fetchRegistry().catch(() => null),
    ]);

    const routeProfile = resolveRouteProfile(state);
    const runtimeName =
      typeof state?.runtime?.name === "string" && state.runtime.name.trim()
        ? state.runtime.name.trim()
        : this.metadata.runtimeName;
    const runtimeVersion =
      typeof state?.runtime?.version === "string" && state.runtime.version.trim()
        ? state.runtime.version.trim()
        : null;
    const vendor =
      typeof state?.runtime?.vendor === "string" && state.runtime.vendor.trim()
        ? state.runtime.vendor.trim()
        : null;

    return {
      metadata: {
        ...this.metadata,
        runtimeName,
        runtimeVersion,
        vendor,
        routeProfile,
      },
      health,
      state,
      registry,
    };
  }

  private async callAgentsList() {
    const descriptor = await this.describeRuntime();
    // The office lists agents once it is connected: follow the operations feed from here
    // if this runtime advertises one (and only then).
    this.syncOpsFeed(descriptor.state);
    if (this.opsFeed) this.opsFleetRefreshAt = Date.now();
    const runtimeName = descriptor.metadata.runtimeName ?? this.metadata.runtimeName ?? "Custom Runtime";
    const agents = buildSyntheticAgents(descriptor.state, runtimeName);
    return {
      defaultId: agents[0]?.id ?? "main",
      mainKey: "main",
      scope: "custom",
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
      })),
    };
  }

  private async callSessionsList(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    const descriptor = await this.describeRuntime();
    const modelChoices = normalizeModelChoices(descriptor.registry);
    // Key the agent's session as its main session ("agent:<id>:main"), the same key
    // fleet hydration searches for and chat.send uses.
    const sessions = agentId
      ? [
          this.ensureSession(
            buildAgentMainSessionKey(agentId, "main"),
            agentId,
            resolveDefaultModelId(descriptor.state, modelChoices)
          ),
        ]
      : [...this.sessions.values()];
    return {
      sessions: sessions.map((session) => ({
        key: session.sessionKey,
        updatedAt: session.updatedAt,
        displayName: session.agentId,
        origin: {
          label: descriptor.metadata.runtimeName ?? "Custom Runtime",
          provider: "custom",
        },
        modelProvider: "custom",
        model: session.model,
      })),
    };
  }

  private async callStatus() {
    return {
      sessions: {
        recent: [...this.sessions.values()].map((session) => ({
          key: session.sessionKey,
          updatedAt: session.updatedAt,
        })),
        byAgent: [...this.sessions.values()].map((session) => ({
          agentId: session.agentId,
          recent: [
            {
              key: session.sessionKey,
              updatedAt: session.updatedAt,
            },
          ],
        })),
      },
    };
  }

  private async callModelsList() {
    const descriptor = await this.describeRuntime();
    const modelIds = normalizeModelChoices(descriptor.registry);
    return {
      models: modelIds.map((id) => ({
        id,
        name: id,
        provider: "custom",
        // Reasoning effort cannot be configured through the custom runtime seam;
        // this hides the chat panel's thinking selector for these models.
        reasoning: false,
      })),
    };
  }

  private async callSessionsPreview(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const keys = Array.isArray(params.keys)
      ? params.keys.filter((value): value is string => typeof value === "string")
      : [];
    return {
      ts: Date.now(),
      previews: keys.map((key) => {
        const session = this.sessions.get(key) ?? null;
        const items = session
          ? session.messages.slice(-8).map((message) => ({
              role: message.role,
              text: message.text,
              timestamp: message.timestamp,
            }))
          : [];
        return {
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        };
      }),
    };
  }

  private async callChatHistory(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      throw new Error("Custom runtime requires sessionKey for chat.history.");
    }
    const session = this.sessions.get(sessionKey) ?? null;
    this.scheduleOpsReassert(sessionKey);
    return {
      sessionKey,
      messages: (session?.messages ?? []).map((message) => ({
        role: message.role,
        content: message.text,
        timestamp: message.timestamp,
      })),
    };
  }

  private async callChatSend(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const message = typeof params.message === "string" ? params.message.trim() : "";
    const runId = typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : "";
    if (!sessionKey || !message) {
      throw new Error("Custom runtime requires sessionKey and message for chat.send.");
    }
    const agentId = parseAgentIdFromSessionKey(sessionKey) ?? "main";
    const descriptor = await this.describeRuntime();
    const modelChoices = normalizeModelChoices(descriptor.registry);
    const session = this.ensureSession(
      sessionKey,
      agentId,
      resolveDefaultModelId(descriptor.state, modelChoices)
    );
    const resolvedRole =
      session.role ??
      resolveOptionalString(descriptor.state?.identity?.role) ??
      undefined;
    const resolvedLane =
      resolveOptionalString(descriptor.state?.identity?.lane) ??
      session.role ??
      undefined;
    const controller = new AbortController();
    if (runId) {
      const activeRun: ActiveRunRecord = { runId, sessionKey, controller };
      this.activeRunsByRunId.set(runId, activeRun);
      this.activeRunIdBySessionKey.set(sessionKey, runId);
    }
    const userTimestamp = Date.now();
    session.messages.push({
      role: "user",
      text: message,
      timestamp: userTimestamp,
    });
    session.updatedAt = userTimestamp;

    try {
      const payload = (await requestCustomRuntime({
        runtimeUrl: this.baseUrl,
        pathname: "/v1/chat/completions",
        method: "POST",
        signal: controller.signal,
        body: {
          model: session.model ?? undefined,
          stream: false,
          role: resolvedRole,
          lane: resolvedLane,
          conversation_id: sessionKey,
          session_id: sessionKey,
          messages: session.messages.map((entry) => ({
            role: entry.role,
            content: entry.text,
          })),
        },
      })) as unknown;
      const assistantText = resolveAssistantTextFromResponse(payload);
      if (!assistantText) {
        throw new Error("Custom runtime returned an empty assistant response.");
      }
      const assistantTimestamp = Date.now();
      session.messages.push({
        role: "assistant",
        text: assistantText,
        timestamp: assistantTimestamp,
      });
      session.updatedAt = assistantTimestamp;
      return {
        status: "completed",
        runId: runId || null,
        text: assistantText,
      };
    } catch (error) {
      if (isAbortLikeError(error, controller)) {
        return {
          status: "aborted",
          runId: runId || null,
        };
      }
      const health = await this.fetchHealth().catch(() => null);
      throw new Error(
        buildChatFailureMessage(
          502,
          error instanceof Error ? error.message : String(error),
          health
        )
      );
    } finally {
      if (runId) {
        this.activeRunsByRunId.delete(runId);
        const activeSessionRunId = this.activeRunIdBySessionKey.get(sessionKey);
        if (activeSessionRunId === runId) {
          this.activeRunIdBySessionKey.delete(sessionKey);
        }
      }
    }
  }

  /**
   * Session settings sync. Custom runtimes have no thinking-level or exec-permission
   * controls, so only "no override" (null/absent) is accepted for those. A model is
   * accepted only when it is the runtime's default or listed in its /registry;
   * anything else is rejected rather than silently ignored.
   */
  private async callSessionsPatch(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const key = typeof params.key === "string" ? params.key.trim() : "";
    if (!key) {
      throw new Error("Custom runtime requires key for sessions.patch.");
    }
    const unsupported = (["thinkingLevel", "execHost", "execSecurity", "execAsk"] as const).filter(
      (field) => resolveOptionalString(params[field]) !== null
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Custom runtime does not support session settings: ${unsupported.join(", ")}.`
      );
    }
    const descriptor = await this.describeRuntime();
    const modelChoices = normalizeModelChoices(descriptor.registry);
    const defaultModel = resolveDefaultModelId(descriptor.state, modelChoices);
    let model = defaultModel;
    const requestedModel = resolveOptionalString(params.model);
    if (requestedModel) {
      // Studio may send "<provider>/<model>"; strip this provider's own prefix only.
      const prefix = `${this.id}/`;
      const bareModel = requestedModel.startsWith(prefix)
        ? requestedModel.slice(prefix.length)
        : requestedModel;
      if (bareModel !== defaultModel && !modelChoices.includes(bareModel)) {
        const available = [defaultModel, ...modelChoices].filter(
          (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index
        );
        throw new Error(
          `Custom runtime does not offer model "${requestedModel}". Available: ${
            available.join(", ") || "none"
          }.`
        );
      }
      model = bareModel;
    }
    const agentId = parseAgentIdFromSessionKey(key) ?? "main";
    const session = this.ensureSession(key, agentId, model);
    session.model = model;
    return {
      ok: true as const,
      key,
      resolved: model ? { modelProvider: this.id, model } : undefined,
    };
  }

  private async callAgentsMessage(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const targetAgentId =
      typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
    const message = typeof params.message === "string" ? params.message.trim() : "";
    const sourceAgentId =
      typeof params.sourceAgentId === "string" ? params.sourceAgentId.trim() : "";
    const sourceLabel =
      typeof params.sourceLabel === "string" ? params.sourceLabel.trim() : "";
    const mode =
      params.mode === "interval" || params.mode === "direct" ? params.mode : "direct";
    const cadenceHint =
      typeof params.cadenceHint === "string" ? params.cadenceHint.trim() : "";
    return this.callChatSend({
      sessionKey: buildAgentMainSessionKey(targetAgentId, "main"),
      message: buildDirectedAgentMessageInstruction({
        targetAgentId,
        message,
        sourceAgentId,
        sourceLabel,
        mode,
        cadenceHint,
      }),
      idempotencyKey:
        typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : undefined,
    });
  }

  private async callAgentsHandoff(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const targetAgentId =
      typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
    const task = typeof params.task === "string" ? params.task.trim() : "";
    const sourceAgentId =
      typeof params.sourceAgentId === "string" ? params.sourceAgentId.trim() : "";
    const sourceLabel =
      typeof params.sourceLabel === "string" ? params.sourceLabel.trim() : "";
    const context =
      typeof params.context === "string" ? params.context.trim() : "";
    const acceptanceCriteria =
      typeof params.acceptanceCriteria === "string"
        ? params.acceptanceCriteria.trim()
        : "";
    const deliverables = Array.isArray(params.deliverables)
      ? params.deliverables.filter((entry): entry is string => typeof entry === "string")
      : [];
    return this.callChatSend({
      sessionKey: buildAgentMainSessionKey(targetAgentId, "main"),
      message: buildAgentHandoffInstruction({
        targetAgentId,
        task,
        sourceAgentId,
        sourceLabel,
        context,
        acceptanceCriteria,
        deliverables,
      }),
      idempotencyKey:
        typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : undefined,
    });
  }

  private async callChatAbort(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const targetRunId = runId || (sessionKey ? this.activeRunIdBySessionKey.get(sessionKey) ?? "" : "");
    if (!targetRunId) {
      return { ok: true };
    }
    const activeRun = this.activeRunsByRunId.get(targetRunId) ?? null;
    activeRun?.controller.abort();
    this.activeRunsByRunId.delete(targetRunId);
    if (activeRun?.sessionKey) {
      const activeSessionRunId = this.activeRunIdBySessionKey.get(activeRun.sessionKey);
      if (activeSessionRunId === targetRunId) {
        this.activeRunIdBySessionKey.delete(activeRun.sessionKey);
      }
    }
    return { ok: true };
  }

  private async callSessionsReset(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const key = typeof params.key === "string" ? params.key.trim() : "";
    if (!key) {
      throw new Error("Custom runtime requires key for sessions.reset.");
    }
    this.sessions.delete(key);
    const activeRunId = this.activeRunIdBySessionKey.get(key);
    if (activeRunId) {
      this.activeRunsByRunId.get(activeRunId)?.controller.abort();
      this.activeRunsByRunId.delete(activeRunId);
      this.activeRunIdBySessionKey.delete(key);
    }
    return { ok: true };
  }

  private async callAgentWait(rawParams: unknown) {
    const params = isRecord(rawParams) ? rawParams : {};
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    // A feed run stays "running" until its recorded end, so the office's run reconciliation
    // does not end an animation that the backend still reports as working.
    const running =
      Boolean(runId) &&
      (this.activeRunsByRunId.has(runId) || Boolean(this.opsFeed?.isRunOpen(runId)));
    return {
      status: running ? "running" : "done",
    };
  }

  /** Start following the operations feed if `state` advertises it; stop if it no longer does. */
  private syncOpsFeed(state: CustomRuntimeStateResponse | null): void {
    const capability = resolveOpsFeedCapability(state);
    if (!capability) {
      this.stopOpsFeed();
      return;
    }
    // Already following (or stopped itself after a protocol change: not restarted until a
    // disconnect clears it, so a mismatched runtime is not polled on every agents.list).
    if (this.opsFeed) return;
    const client = this.client as Partial<GatewayClient> | null;
    if (
      typeof client?.dispatchLocalEvent !== "function" ||
      typeof client?.registerLocalEventSource !== "function"
    ) {
      return;
    }
    const subscription = new OpsFeedSubscription({
      ...capability,
      request: (pathname, signal) =>
        requestCustomRuntime({ runtimeUrl: this.baseUrl, pathname, method: "GET", signal }),
      dispatch: (frame) => this.client.dispatchLocalEvent(frame),
      warn: (message, detail) => console.warn(`[custom-runtime] ${message}`, detail ?? ""),
    });
    this.opsFeed = subscription;
    // The gateway client stops it on disconnect or backend switch, and allows only one feed.
    this.unregisterOpsFeed = this.client.registerLocalEventSource(OPS_FEED_SOURCE_KEY, () =>
      this.stopOpsFeed()
    );
    void subscription.start();
  }

  /**
   * After a fleet refresh the office infers each agent's status from its chat history (this call
   * is the inference's last step) and resets an agent without a pending chat reply to idle. If the
   * feed still holds that agent's run open, show it as started again once the refresh has been
   * applied. Once per run per refresh; never while the agent has a chat run of its own.
   */
  private scheduleOpsReassert(sessionKey: string): void {
    const feed = this.opsFeed;
    if (!feed || feed.isStopped || this.activeRunIdBySessionKey.has(sessionKey)) return;
    if (Date.now() - this.opsFleetRefreshAt > OPS_REASSERT_WINDOW_MS) return;
    const runId = feed.openRunFor(sessionKey);
    if (!runId || (this.opsReassertedAt.get(runId) ?? 0) >= this.opsFleetRefreshAt) return;
    this.opsReassertedAt.set(runId, Date.now());
    const timer = setTimeout(() => {
      this.opsReassertTimers.delete(timer);
      if (this.opsFeed === feed && !this.activeRunIdBySessionKey.has(sessionKey)) {
        feed.reassertOpenRun(sessionKey);
      }
    }, OPS_REASSERT_DELAY_MS);
    this.opsReassertTimers.add(timer);
  }

  private stopOpsFeed(): void {
    const subscription = this.opsFeed;
    const unregister = this.unregisterOpsFeed;
    this.opsFeed = null;
    this.unregisterOpsFeed = null;
    this.opsReassertTimers.forEach((timer) => clearTimeout(timer));
    this.opsReassertTimers.clear();
    this.opsReassertedAt.clear();
    subscription?.stop();
    unregister?.();
  }

  private ensureSession(sessionKey: string, agentId: string, model: string | null): SessionRecord {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const session: SessionRecord = {
      sessionKey,
      agentId,
      role: agentId || null,
      model,
      updatedAt: null,
      messages: [],
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  private async fetchJson<T = unknown>(pathname: string): Promise<T> {
    return fetchCustomRuntimeJson<T>(this.baseUrl, pathname);
  }
}
