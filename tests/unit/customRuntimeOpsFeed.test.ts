import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayRuntimeEventHandler } from "@/features/agents/state/gatewayRuntimeEventHandler";
import type { AgentState } from "@/features/agents/state/store";
import { GatewayClient, type EventFrame } from "@/lib/gateway/GatewayClient";
import {
  createOfficeAnimationTriggerState,
  reduceOfficeAnimationTriggerEvent,
} from "@/lib/office/eventTriggers";
import {
  CustomRuntimeProvider,
  OPS_FEED_PROTOCOL,
  OpsFeedSubscription,
  resolveOpsFeedCapability,
  translateOpsFeedEvent,
  type OpsFeedEvent,
} from "@/lib/runtime/custom/provider";
import { normalizeGatewayEvent } from "@/lib/runtime/normalizeGatewayEvent";

const RUNTIME_URL = "http://127.0.0.1:7780";
const BUSINESS = "agent:business-operations:main";
const RISK = "agent:risk-compliance:main";

const FEED_STATE = {
  profileName: "fmi-ai-operations-centre",
  active: {
    "business-operations": "qwen3:8b",
    "risk-compliance": "qwen3:8b",
    "claims-review": "qwen3:8b",
  },
  runtime: { name: "FMI AI Operations Centre", active_model: "qwen3:8b" },
  capabilities: {
    protocol: OPS_FEED_PROTOCOL,
    opsEvents: "/ops/events",
    opsAgents: "/ops/agents",
    readOnly: true,
  },
};

/** The Claims Adapter's /state: no feed capability. */
const CLAIMS_ADAPTER_STATE = {
  identity: {
    name: "Claims Review Agent",
    role: "claims-reviewer",
    lane: "claims-review",
    model_id: "qwen3:8b",
  },
};

/**
 * A recorded Business -> Risk collaboration as the gateway publishes it (fields as in
 * fmi-ops/1): Business completes with model output and requests the consultation; the Risk
 * step ends with a labelled fallback and returns the consultation INCOMPLETE.
 */
const RECORDED: OpsFeedEvent[] = [
  { seq: 4, kind: "agent.task_assigned", agentId: "business-operations", runId: null },
  { seq: 5, kind: "agent.started", agentId: "business-operations", runId: "RUN-B1", phase: "start" },
  { seq: 7, kind: "agent.model_call", agentId: "business-operations", runId: "RUN-B1" },
  {
    seq: 8,
    kind: "agent.tool",
    agentId: "business-operations",
    runId: "RUN-B1",
    data: { tool: "search_knowledge", code: "ok", target: "form abandonment" },
  },
  {
    seq: 20,
    kind: "agent.finished",
    agentId: "business-operations",
    runId: "RUN-B1",
    data: { task: "analyse_proposal", provenance: "model" },
  },
  {
    seq: 23,
    kind: "handoff.consultation_requested",
    agentId: "business-operations",
    runId: "RUN-B1",
    data: { questions: 5, changesInScope: ["CHG-1", "CHG-2"] },
  },
  {
    seq: 24,
    kind: "agent.step_completed",
    agentId: "business-operations",
    runId: "RUN-B1",
    phase: "end",
  },
  { seq: 25, kind: "workflow.state", runId: null },
  { seq: 27, kind: "agent.started", agentId: "risk-compliance", runId: "RUN-R1", phase: "start" },
  {
    seq: 28,
    kind: "agent.tool",
    agentId: "risk-compliance",
    runId: "RUN-R1",
    data: { tool: "search_knowledge", code: "ok", target: "(query not shown)" },
  },
  {
    seq: 114,
    kind: "agent.finished",
    agentId: "risk-compliance",
    runId: "RUN-R1",
    data: { task: "assess_consultation", provenance: "fallback" },
  },
  {
    seq: 117,
    kind: "handoff.consultation_returned",
    agentId: "risk-compliance",
    runId: "RUN-R1",
    data: { outcome: "incomplete", successful: false },
  },
  {
    seq: 118,
    kind: "agent.step_completed",
    agentId: "risk-compliance",
    runId: "RUN-R1",
    phase: "error",
  },
  { seq: 119, kind: "human.decision", runId: null, data: { decision: "accept" } },
];

const payloadOf = (frame: EventFrame) =>
  frame.payload as { runId: string; sessionKey: string; stream: string; data: Record<string, unknown> };

const describeFrame = (frame: EventFrame): string => {
  const p = payloadOf(frame);
  const what =
    p.stream === "lifecycle" ? String(p.data.phase) : p.stream === "activity" ? String(p.data.kind) : String(p.data.name);
  return `${p.sessionKey.split(":")[1]} ${p.runId} ${p.stream}:${what}`;
};

const createAgent = (agentId: string, sessionKey: string): AgentState =>
  ({
    agentId,
    name: agentId,
    sessionKey,
    status: "idle",
    sessionCreated: true,
    awaitingUserInput: false,
    hasUnseenActivity: false,
    outputLines: [],
    lastResult: null,
    lastDiff: null,
    runId: null,
    runStartedAt: null,
    streamText: null,
    thinkingTrace: null,
    latestOverride: null,
    latestOverrideKind: null,
    lastAssistantMessageAt: null,
    lastActivityAt: null,
    latestPreview: null,
    lastUserMessage: null,
    draft: "",
    sessionSettingsSynced: true,
    historyLoadedAt: null,
    historyFetchLimit: null,
    historyFetchedCount: null,
    historyMaybeTruncated: false,
    toolCallingEnabled: true,
    showThinkingTraces: true,
    model: "qwen3:8b",
    thinkingLevel: null,
    avatarSeed: agentId,
    avatarUrl: null,
  }) as AgentState;

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type ProxyBody = { runtimeUrl: string; pathname: string; method: string; body?: unknown };

/** Stands in for Hermes3D's /api/runtime/custom proxy in front of the lab gateway. */
const installGatewayFetch = (options: {
  state?: unknown;
  agents: () => unknown;
  pages: unknown[];
}) => {
  const proxied: ProxyBody[] = [];
  const pages = [...options.pages];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ProxyBody;
    proxied.push(body);
    const path = body.pathname.split("?")[0];
    switch (path) {
      case "/health":
        return jsonResponse({ ok: true, status: "ok", protocol: OPS_FEED_PROTOCOL });
      case "/state":
        return jsonResponse(options.state ?? FEED_STATE);
      case "/registry":
        return jsonResponse({ models: { "qwen3:8b": {} } });
      case "/ops/agents":
        return jsonResponse(options.agents());
      case "/ops/events": {
        const page = pages.shift();
        if (page !== undefined) return jsonResponse(page);
        // A long poll with nothing new: stays open until the client aborts it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
      }
      case "/v1/chat/completions":
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "# Preliminary claim review - CLM-1004" } }],
        });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { proxied, fetchMock, pages };
};

const agentsPayload = (cursor: number, working: Array<{ agentId: string; runId: string }> = []) => ({
  protocol: OPS_FEED_PROTOCOL,
  cursor,
  agents: [
    { agentId: "business-operations", status: "idle" },
    { agentId: "risk-compliance", status: "idle" },
    { agentId: "claims-review", status: "idle" },
  ].map((agent) => {
    const run = working.find((entry) => entry.agentId === agent.agentId);
    return run ? { ...agent, status: "working", runId: run.runId } : agent;
  }),
});

const page = (events: OpsFeedEvent[], cursor: number) => ({
  protocol: OPS_FEED_PROTOCOL,
  cursor,
  events,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("operations feed capability", () => {
  it("is detected only when /state explicitly advertises fmi-ops/1", () => {
    expect(resolveOpsFeedCapability(FEED_STATE)).toEqual({
      eventsPath: "/ops/events",
      agentsPath: "/ops/agents",
    });
    expect(resolveOpsFeedCapability(CLAIMS_ADAPTER_STATE)).toBeNull();
    expect(resolveOpsFeedCapability({ capabilities: { protocol: "fmi-ops/2" } })).toBeNull();
    expect(resolveOpsFeedCapability({ capabilities: { opsEvents: "/ops/events" } })).toBeNull();
    expect(resolveOpsFeedCapability(null)).toBeNull();
  });

  it("only follows plain paths on the same runtime", () => {
    const capability = resolveOpsFeedCapability({
      capabilities: {
        protocol: OPS_FEED_PROTOCOL,
        opsEvents: "http://evil.example/feed",
        opsAgents: "/ops/agents?x=1",
      },
    });
    expect(capability).toEqual({ eventsPath: "/ops/events", agentsPath: "/ops/agents" });
  });
});

describe("translating recorded events into office frames", () => {
  it("animates each step from its recorded start to its recorded end, with outcomes and handoffs", () => {
    const openRuns = new Map<string, string>();
    const frames = RECORDED.flatMap((event) => translateOpsFeedEvent(event, openRuns));
    expect(frames.map(describeFrame)).toEqual([
      "business-operations RUN-B1 lifecycle:start",
      "business-operations RUN-B1 activity:model_call", // a recorded model round: activity, no content
      "business-operations RUN-B1 tool:search_knowledge",
      "business-operations RUN-B1 tool:step_outcome",
      "business-operations RUN-B1 tool:handoff",
      "business-operations RUN-B1 lifecycle:end",
      "risk-compliance RUN-R1 lifecycle:start",
      "risk-compliance RUN-R1 tool:search_knowledge",
      "risk-compliance RUN-R1 tool:step_outcome",
      "risk-compliance RUN-R1 tool:handoff",
      "risk-compliance RUN-R1 lifecycle:error", // the incomplete consultation is an error, not a success
    ]);
    expect(openRuns.size).toBe(0);
    const data = frames.map((frame) => payloadOf(frame).data);
    expect(data[1]).toEqual({ source: "fmi-ops", kind: "model_call" });
    expect(data[3]).toMatchObject({ arguments: { task: "analyse_proposal", output: "model output" } });
    expect(data[4]).toMatchObject({
      arguments: { from: "business-operations", to: "risk-compliance", consultation: "requested" },
    });
    expect(data[8]).toMatchObject({
      arguments: { output: "DETERMINISTIC FALLBACK (not model output)" },
    });
    expect(data[9]).toMatchObject({
      arguments: { to: "business-operations", outcome: "incomplete", successful: false },
    });
    expect(data[2]).toMatchObject({ toolCallId: "ops-8", phase: "call" });
    expect(frames.every((frame) => frame.seq === undefined)).toBe(true); // no gap-detection seq
  });

  it("produces nothing it has no evidence for", () => {
    const openRuns = new Map<string, string>();
    const unobserved: OpsFeedEvent[] = [
      // tool, outcome and end of a run whose start was never seen
      { seq: 1, kind: "agent.tool", agentId: "risk-compliance", runId: "RUN-X", data: { tool: "x" } },
      { seq: 2, kind: "agent.finished", agentId: "risk-compliance", runId: "RUN-X", data: {} },
      { seq: 3, kind: "agent.step_completed", agentId: "risk-compliance", runId: "RUN-X", phase: "end" },
      // agents the feed does not animate, and events without a run
      { seq: 4, kind: "agent.started", agentId: "claims-review", runId: "RUN-C", phase: "start" },
      { seq: 5, kind: "agent.started", agentId: "someone-else", runId: "RUN-S", phase: "start" },
      { seq: 6, kind: "agent.started", agentId: "business-operations", runId: null, phase: "start" },
      // human decisions and workflow states never become frames (nothing can look approved)
      { seq: 7, kind: "human.decision", runId: "RUN-X", data: { decision: "accept" } },
      { seq: 8, kind: "workflow.state", runId: null, data: { to: "approved_for_planning" } },
    ];
    expect(unobserved.flatMap((event) => translateOpsFeedEvent(event, openRuns))).toEqual([]);
    expect(openRuns.size).toBe(0);
  });

  it("ends failed and interrupted attempts as errors, and keeps unsafe tool names out", () => {
    const openRuns = new Map<string, string>();
    const frames = [
      { seq: 1, kind: "agent.started", agentId: "business-operations", runId: "A", phase: "start" },
      { seq: 2, kind: "agent.tool", runId: "A", data: { tool: "<img src=x>", code: "ok" } },
      { seq: 3, kind: "agent.step_failed", runId: "A", phase: "error" },
      { seq: 4, kind: "agent.started", agentId: "risk-compliance", runId: "B", phase: "start" },
      { seq: 5, kind: "agent.step_interrupted", runId: "B", phase: "error" },
    ].flatMap((event) => translateOpsFeedEvent(event as OpsFeedEvent, openRuns));
    expect(frames.map(describeFrame)).toEqual([
      "business-operations A lifecycle:start",
      "business-operations A tool:tool",
      "business-operations A lifecycle:error",
      "risk-compliance B lifecycle:start",
      "risk-compliance B lifecycle:error",
    ]);
  });

  it("uses frames Hermes3D already understands", () => {
    const openRuns = new Map<string, string>();
    const frames = RECORDED.flatMap((event) => translateOpsFeedEvent(event, openRuns));
    const lifecycle = frames
      .map((frame) => normalizeGatewayEvent(frame))
      .filter((event) => event.type === "run.lifecycle");
    expect(lifecycle.map((event) => event.type === "run.lifecycle" && [event.sessionKey, event.phase])).toEqual([
      [BUSINESS, "start"],
      [BUSINESS, "end"],
      [RISK, "start"],
      [RISK, "error"],
    ]);
    const agents = [
      createAgent("business-operations", BUSINESS),
      createAgent("risk-compliance", RISK),
    ];
    const triggers = reduceOfficeAnimationTriggerEvent({
      state: createOfficeAnimationTriggerState(),
      event: frames[0]!,
      agents,
      nowMs: 1_000,
    });
    expect(triggers.workingUntilByAgentId["business-operations"]).toBeGreaterThan(1_000);
    expect(triggers.workingUntilByAgentId["risk-compliance"]).toBeUndefined();
  });
});

const officeHandler = (agents: AgentState[]) => {
  const lines: Array<{ agentId: string; line: string }> = [];
  const statuses: string[] = [];
  const apply = (agentId: string, patch: Partial<AgentState>) => {
    const index = agents.findIndex((agent) => agent.agentId === agentId);
    agents[index] = { ...agents[index]!, ...patch };
    if (patch.status) statuses.push(`${agentId}:${patch.status}`);
  };
  const handler = createGatewayRuntimeEventHandler({
    getStatus: () => "connected",
    getAgents: () => agents,
    dispatch: (action) => {
      const a = action as { type: string; agentId: string; line?: string; patch?: Partial<AgentState> };
      if (a.type === "appendOutput" && a.line) lines.push({ agentId: a.agentId, line: a.line });
      if (a.type === "updateAgent" && a.patch) apply(a.agentId, a.patch);
    },
    queueLivePatch: (agentId, patch) => apply(agentId, patch),
    clearPendingLivePatch: vi.fn(),
    now: () => 1_000,
    loadSummarySnapshot: vi.fn(async () => {}),
    requestHistoryRefresh: vi.fn(async () => {}),
    refreshHeartbeatLatestUpdate: vi.fn(),
    bumpHeartbeatTick: vi.fn(),
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
    isDisconnectLikeError: () => false,
    logWarn: vi.fn(),
    updateSpecialLatestUpdate: vi.fn(),
  });
  return { handler, lines, statuses, apply };
};

describe("through the office's own runtime event handler", () => {
  it("activity frames keep a working agent working and add nothing to its transcript", () => {
    const agents = [createAgent("risk-compliance", RISK)];
    const { handler, lines, statuses } = officeHandler(agents);
    try {
      const openRuns = new Map<string, string>();
      const frames = [
        { seq: 1, kind: "agent.started", agentId: "risk-compliance", runId: "R", phase: "start" },
        { seq: 2, kind: "agent.model_call", runId: "R" },
      ].flatMap((event) => translateOpsFeedEvent(event as OpsFeedEvent, openRuns));
      frames.forEach((frame) => handler.handleEvent(frame));
    } finally {
      handler.dispose();
    }
    expect(agents[0]).toMatchObject({ status: "running", runId: "R" });
    expect(statuses).toEqual(["risk-compliance:running"]);
    expect(lines).toEqual([]);
  });

  it("shows the recorded failure even after the office's fleet refresh reset the agent to idle", () => {
    // Live finding: after 120 s without events (a long model call), or on window focus, the office
    // re-reads its fleet and infers "idle" for an agent without a pending chat reply. Without a
    // re-assert, the run's later error frame is then dropped and the failure never shows.
    const run = (reassert: boolean) => {
      const agents = [createAgent("risk-compliance", RISK)];
      const { handler, apply } = officeHandler(agents);
      try {
        const openRuns = new Map<string, string>();
        const start = { seq: 1, kind: "agent.started", agentId: "risk-compliance", runId: "R", phase: "start" };
        translateOpsFeedEvent(start as OpsFeedEvent, openRuns).forEach((f) => handler.handleEvent(f));
        apply("risk-compliance", { status: "idle", runId: null }); // the office's fleet-refresh inference
        if (reassert) {
          const again = new OpsFeedSubscription({
            eventsPath: "/ops/events",
            agentsPath: "/ops/agents",
            request: async () => ({}),
            dispatch: (frame) => handler.handleEvent(frame),
          });
          again.openRuns.set("R", RISK);
          expect(again.reassertOpenRun(RISK)).toBe(true);
        }
        const end = { seq: 2, kind: "agent.step_completed", runId: "R", phase: "error" };
        translateOpsFeedEvent(end as OpsFeedEvent, openRuns).forEach((f) => handler.handleEvent(f));
      } finally {
        handler.dispose();
      }
      return agents[0]!.status;
    };
    expect(run(false)).toBe("idle"); // the hazard: the recorded failure would be invisible
    expect(run(true)).toBe("error"); // with the re-assert, the office shows what was recorded
  });

  it("shows Business working then idle, Risk working then in error, with the tool lines", () => {
    const agents = [
      createAgent("business-operations", BUSINESS),
      createAgent("risk-compliance", RISK),
    ];
    const lines: Array<{ agentId: string; line: string }> = [];
    const statuses: string[] = [];
    const apply = (agentId: string, patch: Partial<AgentState>) => {
      const index = agents.findIndex((agent) => agent.agentId === agentId);
      agents[index] = { ...agents[index]!, ...patch };
      if (patch.status) statuses.push(`${agentId}:${patch.status}`);
    };
    const handler = createGatewayRuntimeEventHandler({
      getStatus: () => "connected",
      getAgents: () => agents,
      dispatch: (action) => {
        const a = action as { type: string; agentId: string; line?: string; patch?: Partial<AgentState> };
        if (a.type === "appendOutput" && a.line) lines.push({ agentId: a.agentId, line: a.line });
        if (a.type === "updateAgent" && a.patch) apply(a.agentId, a.patch);
      },
      queueLivePatch: (agentId, patch) => apply(agentId, patch),
      clearPendingLivePatch: vi.fn(),
      now: () => 1_000,
      loadSummarySnapshot: vi.fn(async () => {}),
      requestHistoryRefresh: vi.fn(async () => {}),
      refreshHeartbeatLatestUpdate: vi.fn(),
      bumpHeartbeatTick: vi.fn(),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      isDisconnectLikeError: () => false,
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });
    try {
      const openRuns = new Map<string, string>();
      for (const event of RECORDED) {
        for (const frame of translateOpsFeedEvent(event, openRuns)) handler.handleEvent(frame);
      }
    } finally {
      handler.dispose();
    }
    expect(statuses.filter((s) => s.startsWith("business"))).toEqual([
      "business-operations:running",
      "business-operations:idle",
    ]);
    expect(statuses.filter((s) => s.startsWith("risk"))).toEqual([
      "risk-compliance:running",
      "risk-compliance:error",
    ]);
    expect(agents.map((agent) => [agent.agentId, agent.status, agent.runId])).toEqual([
      ["business-operations", "idle", null],
      ["risk-compliance", "error", null],
    ]);
    const riskLines = lines.filter((entry) => entry.agentId === "risk-compliance").map((e) => e.line).join("\n");
    expect(riskLines).toContain("step_outcome (ops-114)");
    expect(riskLines).toContain("DETERMINISTIC FALLBACK (not model output)");
    expect(riskLines).toContain('"successful": false');
    const businessLines = lines.filter((entry) => entry.agentId === "business-operations").map((e) => e.line);
    expect(businessLines.some((line) => line.includes("search_knowledge (ops-8)"))).toBe(true);
  });
});

describe("following the feed", () => {
  const follow = (
    pages: unknown[],
    agents: () => unknown,
    extra?: Record<string, unknown>,
    idleCursor?: number // when set, an exhausted feed answers empty pages instead of hanging
  ) => {
    const requested: string[] = [];
    const frames: EventFrame[] = [];
    const queue = [...pages];
    const request = vi.fn(async (pathname: string, signal: AbortSignal) => {
      requested.push(pathname);
      if (pathname.startsWith("/ops/agents")) return agents();
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next !== undefined) return next;
      if (idleCursor !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return page([], idleCursor);
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const subscription = new OpsFeedSubscription({
      eventsPath: "/ops/events",
      agentsPath: "/ops/agents",
      request,
      dispatch: (frame) => frames.push(frame),
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      warn: vi.fn(),
      ...extra,
    });
    const done = subscription.start();
    return { subscription, requested, frames, request, queue, done };
  };

  it("starts from now: shows agents working right now, then follows without replaying history", async () => {
    const { subscription, requested, frames, done } = follow(
      [page([{ seq: 61, kind: "agent.step_completed", runId: "RUN-R9", phase: "end" }], 61)],
      () => agentsPayload(60, [{ agentId: "risk-compliance", runId: "RUN-R9" }])
    );
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map(describeFrame)).toEqual([
      "risk-compliance RUN-R9 lifecycle:start", // seeded: recorded as working right now
      "risk-compliance RUN-R9 lifecycle:end",
    ]);
    expect(requested[0]).toBe("/ops/agents");
    expect(requested[1]).toBe("/ops/events?after=60&limit=200&wait=20");
    subscription.stop();
    await done;
  });

  it("delivers each event once, carries the cursor, and resumes from it after failures", async () => {
    const started = { seq: 11, kind: "agent.started", agentId: "business-operations", runId: "B", phase: "start" };
    const ended = { seq: 12, kind: "agent.step_completed", runId: "B", phase: "end" };
    const { subscription, requested, frames, done } = follow(
      [
        page([started as OpsFeedEvent], 11),
        new Error("Custom runtime proxy failed."), // gateway restarting
        new Error("Too many long polls (429)"),
        page([started as OpsFeedEvent, ended as OpsFeedEvent], 15), // replayed 11 must not repeat
        page([], 15),
      ],
      () => agentsPayload(10)
    );
    await vi.waitFor(() => expect(requested.filter((p) => p.startsWith("/ops/events")).length).toBe(6));
    expect(frames.map(describeFrame)).toEqual([
      "business-operations B lifecycle:start",
      "business-operations B lifecycle:end",
    ]);
    expect(requested.filter((p) => p.startsWith("/ops/events")).map((p) => p.split("&")[0])).toEqual([
      "/ops/events?after=10",
      "/ops/events?after=11",
      "/ops/events?after=11", // reconnect resumes from the same cursor
      "/ops/events?after=11",
      "/ops/events?after=15", // the page cursor moves past events the feed does not publish
      "/ops/events?after=15",
    ]);
    subscription.stop();
    await done;
  });

  it("backs off exponentially while the runtime is unavailable", async () => {
    vi.useFakeTimers();
    const failure = new Error("Custom runtime proxy failed.");
    const { subscription, requested, done } = follow(
      [failure, failure, failure],
      () => agentsPayload(0),
      { initialBackoffMs: 1_000, maxBackoffMs: 4_000 }
    );
    const polls = () => requested.filter((p) => p.startsWith("/ops/events")).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(polls()).toBe(4); // capped at 4 s
    subscription.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls()).toBe(4);
    await done;
  });

  it("stops for good if the runtime starts speaking another protocol", async () => {
    const { subscription, requested, done } = follow(
      [{ protocol: "fmi-ops/2", cursor: 0, events: [] }],
      () => agentsPayload(0)
    );
    await done;
    expect(subscription.isStopped).toBe(true);
    expect(requested).toEqual(["/ops/agents", "/ops/events?after=0&limit=200&wait=20"]);
  });

  it("stop() aborts the open long poll and makes no further requests", async () => {
    const { subscription, requested, request, done } = follow([], () => agentsPayload(3));
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    const signal = request.mock.calls[1]![1];
    subscription.stop();
    await done;
    expect(signal.aborted).toBe(true);
    expect(requested).toHaveLength(2);
  });

  it("ends a run that stopped without a recorded end (its process died) as an error", async () => {
    const start = { seq: 21, kind: "agent.started", agentId: "risk-compliance", runId: "R", phase: "start" };
    let calls = 0;
    let processDied = false;
    const { subscription, frames, request, done } = follow(
      [page([start as OpsFeedEvent], 21)],
      () => {
        calls += 1;
        if (calls === 1) return agentsPayload(20); // the seed, before Risk started
        return processDied
          ? agentsPayload(21) // Risk's step is no longer recorded as working
          : agentsPayload(21, [{ agentId: "risk-compliance", runId: "R" }]);
      },
      undefined,
      21
    );
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3)); // reconciled while still working
    const lifecycle = () => frames.filter((f) => payloadOf(f).stream === "lifecycle").map(describeFrame);
    expect(lifecycle()).toEqual(["risk-compliance R lifecycle:start"]);
    // each confirmation that the run is still working keeps the office from seeing silence
    expect(frames.map(describeFrame)).toContain("risk-compliance R activity:still_working");
    processDied = true;
    await vi.waitFor(() => expect(lifecycle()).toHaveLength(2));
    expect(request).toHaveBeenCalled();
    expect(lifecycle()).toEqual(["risk-compliance R lifecycle:start", "risk-compliance R lifecycle:error"]);
    subscription.stop();
    await done;
  });

  it("does not end a run while newer events are still to be delivered", async () => {
    const start = { seq: 21, kind: "agent.started", agentId: "risk-compliance", runId: "R", phase: "start" };
    const end = { seq: 22, kind: "agent.step_completed", runId: "R", phase: "end" };
    let calls = 0;
    const { subscription, frames, done } = follow(
      [page([start as OpsFeedEvent], 21), page([], 21), page([end as OpsFeedEvent], 22)],
      () => {
        calls += 1;
        // the seed; then a view in which the end is already recorded (cursor 22) but the feed
        // has not yet delivered it: Risk is not working, yet this must not become an error
        return calls === 1 ? agentsPayload(20) : agentsPayload(22);
      }
    );
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map(describeFrame)[1]).toBe("risk-compliance R lifecycle:end"); // not an error
    subscription.stop();
    await done;
  });
});

describe("the custom runtime provider", () => {
  const providerFor = (client: GatewayClient) =>
    new CustomRuntimeProvider(client, RUNTIME_URL, { id: "custom" });

  it("follows the feed once agents are listed, and only reads", async () => {
    const run = { agentId: "business-operations", runId: "RUN-B1" };
    const { proxied } = installGatewayFetch({
      agents: () => agentsPayload(40, [run]), // Business is working when Hermes3D connects
      pages: [
        page(
          [
            { seq: 41, kind: "agent.tool", runId: "RUN-B1", data: { tool: "search_knowledge", code: "ok" } },
            { seq: 42, kind: "agent.step_completed", runId: "RUN-B1", phase: "end" },
          ],
          50
        ),
      ],
    });
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    const provider = providerFor(client);

    await provider.call("agents.list", {});
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
    expect(received.map(describeFrame)[0]).toBe("business-operations RUN-B1 lifecycle:start");
    await vi.waitFor(() =>
      expect(received.map(describeFrame)).toContain("business-operations RUN-B1 lifecycle:end")
    );

    const opsRequests = proxied.filter((body) => body.pathname.startsWith("/ops/"));
    expect(opsRequests.length).toBeGreaterThan(0);
    expect(opsRequests.every((body) => body.method === "GET" && body.runtimeUrl === RUNTIME_URL)).toBe(true);
    expect(proxied.some((body) => body.pathname === "/v1/chat/completions")).toBe(false); // no chat, no model
    client.disconnect();
  });

  it("reports a feed run as running to the office's reconciliation until its recorded end", async () => {
    const start = { seq: 41, kind: "agent.started", agentId: "risk-compliance", runId: "RUN-R1", phase: "start" };
    const end = { seq: 42, kind: "agent.step_completed", runId: "RUN-R1", phase: "error" };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installGatewayFetch({ agents: () => agentsPayload(40), pages: [page([start as OpsFeedEvent], 41)] });
    const realFetch = globalThis.fetch;
    let eventPolls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ProxyBody;
      if (body.pathname.startsWith("/ops/events") && ++eventPolls === 2) {
        await gate; // the end is recorded only when the test says so
        return jsonResponse(page([end as OpsFeedEvent], 42));
      }
      return realFetch(input, init);
    });
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    const provider = providerFor(client);
    await provider.call("agents.list", {});
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(await provider.call("agent.wait", { runId: "RUN-R1", timeoutMs: 1 })).toEqual({ status: "running" });
    release();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(describeFrame(received[1]!)).toBe("risk-compliance RUN-R1 lifecycle:error");
    expect(await provider.call("agent.wait", { runId: "RUN-R1", timeoutMs: 1 })).toEqual({ status: "done" });
    client.disconnect();
  });

  it("stops polling on disconnect, and restarts from a fresh view on reconnect", async () => {
    const { proxied } = installGatewayFetch({ agents: () => agentsPayload(5), pages: [] });
    const client = new GatewayClient();
    const provider = providerFor(client);
    await provider.call("agents.list", {});
    await vi.waitFor(() =>
      expect(proxied.filter((b) => b.pathname.startsWith("/ops/events")).length).toBe(1)
    );
    client.disconnect(); // what the office does on Disconnect, on a backend switch and on unmount
    const afterDisconnect = proxied.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(proxied.length).toBe(afterDisconnect);

    await provider.call("agents.list", {}); // connected again
    await vi.waitFor(() =>
      expect(proxied.filter((b) => b.pathname.startsWith("/ops/events")).length).toBe(2)
    );
    expect(proxied.filter((b) => b.pathname === "/ops/agents").length).toBe(2); // re-seeded from now
    client.disconnect();
  });

  it("runs at most one feed per client, so a new provider never duplicates frames", async () => {
    const { proxied } = installGatewayFetch({ agents: () => agentsPayload(5), pages: [] });
    const client = new GatewayClient();
    const first = providerFor(client);
    const second = providerFor(client); // e.g. the provider recreated after a settings change
    await first.call("agents.list", {});
    await vi.waitFor(() => expect(proxied.filter((b) => b.pathname.startsWith("/ops/events")).length).toBe(1));
    await second.call("agents.list", {});
    await vi.waitFor(() => expect(proxied.filter((b) => b.pathname.startsWith("/ops/events")).length).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(proxied.filter((b) => b.pathname.startsWith("/ops/events")).length).toBe(2); // first stopped
    client.disconnect();
  });

  it("never polls a runtime without the capability, and Claims Review chat is unchanged", async () => {
    const { proxied } = installGatewayFetch({
      state: CLAIMS_ADAPTER_STATE,
      agents: () => agentsPayload(0),
      pages: [],
    });
    const client = new GatewayClient();
    const handlers = vi.fn();
    client.onEvent(handlers);
    const provider = providerFor(client);
    const listed = await provider.call<{ agents: Array<{ id: string }> }>("agents.list", {});
    expect(listed.agents.map((agent) => agent.id)).toEqual(["claims-review"]);
    const reply = await provider.call<{ status: string; text: string }>("chat.send", {
      sessionKey: "agent:claims-review:main",
      message: "Review CLM-1004",
      idempotencyKey: "run-claims-1",
    });
    expect(reply).toMatchObject({ status: "completed", text: "# Preliminary claim review - CLM-1004" });
    const chat = proxied.find((body) => body.pathname === "/v1/chat/completions")!;
    expect(chat.body).toMatchObject({
      role: "claims-review",
      session_id: "agent:claims-review:main",
      messages: [{ role: "user", content: "Review CLM-1004" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(proxied.some((body) => body.pathname.startsWith("/ops/"))).toBe(false);
    expect(handlers).not.toHaveBeenCalled();
  });

  it("re-asserts an open run after the office's fleet refresh reads that agent's history", async () => {
    installGatewayFetch({
      agents: () => agentsPayload(40, [{ agentId: "risk-compliance", runId: "RUN-R1" }]),
      pages: [],
    });
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    const provider = providerFor(client);
    await provider.call("agents.list", {}); // the office's fleet refresh
    await vi.waitFor(() => expect(received.map(describeFrame)).toEqual(["risk-compliance RUN-R1 lifecycle:start"]));
    // the refresh's status inference reads each agent's history, then resets agents to idle
    await provider.call("chat.history", { sessionKey: RISK });
    await provider.call("chat.history", { sessionKey: BUSINESS }); // no open run: nothing to re-assert
    await provider.call("chat.history", { sessionKey: RISK }); // same refresh: only once
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(received.map(describeFrame)).toEqual([
      "risk-compliance RUN-R1 lifecycle:start",
      "risk-compliance RUN-R1 lifecycle:start",
    ]);
    client.disconnect();
  });

  it("never re-asserts over the agent's own chat run", async () => {
    installGatewayFetch({
      agents: () => agentsPayload(40, [{ agentId: "risk-compliance", runId: "RUN-R1" }]),
      pages: [],
    });
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    const provider = providerFor(client);
    await provider.call("agents.list", {});
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const realFetch = globalThis.fetch;
    let release: () => void = () => {};
    let chatInFlight = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ProxyBody;
      if (body.pathname === "/v1/chat/completions") {
        chatInFlight = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realFetch(input, init);
    });
    const chat = provider.call("chat.send", { sessionKey: RISK, message: "status", idempotencyKey: "chat-1" });
    await vi.waitFor(() => expect(chatInFlight).toBe(true)); // the person's chat run is now active
    await provider.call("chat.history", { sessionKey: RISK });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(received).toHaveLength(1); // no re-assert while the person's chat run is active
    release();
    await chat;
    client.disconnect();
  });

  it("cancels a scheduled re-assert if the person starts a chat with that agent meanwhile", async () => {
    installGatewayFetch({
      agents: () => agentsPayload(40, [{ agentId: "risk-compliance", runId: "RUN-R1" }]),
      pages: [],
    });
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    const provider = providerFor(client);
    await provider.call("agents.list", {});
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await provider.call("chat.history", { sessionKey: RISK }); // re-assert scheduled (750 ms)
    const realFetch = globalThis.fetch;
    let release: () => void = () => {};
    let chatInFlight = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ProxyBody;
      if (body.pathname === "/v1/chat/completions") {
        chatInFlight = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return realFetch(input, init);
    });
    const chat = provider.call("chat.send", { sessionKey: RISK, message: "status", idempotencyKey: "chat-2" });
    await vi.waitFor(() => expect(chatInFlight).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(received).toHaveLength(1); // the chat run owns the agent now: no feed start over it
    release();
    await chat;
    client.disconnect();
  });

  it("re-asserts only the given agent's own open run", () => {
    const frames: EventFrame[] = [];
    const subscription = new OpsFeedSubscription({
      eventsPath: "/ops/events",
      agentsPath: "/ops/agents",
      request: async () => ({}),
      dispatch: (frame) => frames.push(frame),
    });
    subscription.openRuns.set("RUN-R1", RISK);
    expect(subscription.reassertOpenRun(BUSINESS)).toBe(false); // Business has no open run
    expect(frames).toEqual([]);
    expect(subscription.reassertOpenRun(RISK)).toBe(true);
    expect(frames.map(describeFrame)).toEqual(["risk-compliance RUN-R1 lifecycle:start"]);
    subscription.stop();
    expect(subscription.reassertOpenRun(RISK)).toBe(false); // nothing after stop
  });

  it("does not touch a client without local event support (older or fake clients)", async () => {
    installGatewayFetch({ agents: () => agentsPayload(0), pages: [] });
    const provider = new CustomRuntimeProvider({} as unknown as GatewayClient, RUNTIME_URL, { id: "custom" });
    await expect(provider.call("agents.list", {})).resolves.toMatchObject({ defaultId: "business-operations" });
  });
});
