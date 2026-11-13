import { createRequire } from "node:module";
import { createElement, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentState, AgentStoreSeed } from "@/features/agents/state/store";
import {
  buildOfficeAnimationState,
  createOfficeAnimationTriggerState,
  createReplaySafeUpdater,
  dropExpiredUntilEntries,
  reconcileOfficeAnimationTriggerState,
  type OfficeAnimationTriggerState,
} from "@/lib/office/eventTriggers";

/*
 * Regression test for the OfficeScreen render loop ("Maximum update depth exceeded"), run with real
 * React and its real scheduler. The harness mirrors OfficeScreen's structure:
 *
 * - an effect on the agent list queues a trigger-state reconcile and a dance-latch filter;
 * - a memo derives the office animation state from them;
 * - an effect on a derived map calls a setter whose updater returns the previous value.
 *
 * The bug needs a commit at React's idle priority. Its effects then queue idle-lane updates that
 * stay pending while normal work continues, and React re-applies the later queued updaters to the
 * older base state on every render. An updater that returns a new object on each application keeps
 * re-firing the derived effect, so the loop never ends. The fixed updaters (as OfficeScreen now
 * queues them) capture their inputs, including the clock, when queued; return the same object when
 * re-applied to the same state (createReplaySafeUpdater); and return the previous state when
 * nothing changed.
 */

const makeAgent = (
  overrides: Partial<AgentState> & Pick<AgentStoreSeed, "agentId" | "name" | "sessionKey">,
): AgentState => ({
  agentId: overrides.agentId,
  name: overrides.name,
  sessionKey: overrides.sessionKey,
  avatarSeed: overrides.agentId,
  avatarUrl: null,
  model: null,
  thinkingLevel: "high",
  status: overrides.status ?? "idle",
  sessionCreated: true,
  awaitingUserInput: false,
  hasUnseenActivity: false,
  outputLines: [],
  lastResult: null,
  lastDiff: null,
  runId: overrides.runId ?? null,
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
  queuedMessages: [],
  sessionSettingsSynced: true,
  historyLoadedAt: null,
  historyFetchLimit: null,
  historyFetchedCount: null,
  historyMaybeTruncated: false,
  toolCallingEnabled: false,
  showThinkingTraces: true,
  transcriptEntries: [],
  transcriptRevision: 0,
  transcriptSequenceCounter: 0,
  sessionEpoch: 0,
  lastHistoryRequestRevision: null,
  lastAppliedHistoryRequestId: null,
});

const IDLE_AGENTS = [
  makeAgent({ agentId: "business-operations", name: "Business", sessionKey: "agent:business-operations:main" }),
  makeAgent({ agentId: "risk-compliance", name: "Risk", sessionKey: "agent:risk-compliance:main" }),
  makeAgent({ agentId: "claims-review", name: "Claims", sessionKey: "agent:claims-review:main" }),
];
const WORKING_AGENTS = [
  makeAgent({ agentId: "business-operations", name: "Business", sessionKey: "agent:business-operations:main",
    status: "running", runId: "RUN-B" }),
  makeAgent({ agentId: "risk-compliance", name: "Risk", sessionKey: "agent:risk-compliance:main", status: "error" }),
  makeAgent({ agentId: "claims-review", name: "Claims", sessionKey: "agent:claims-review:main" }),
];

type Setter<T> = (update: (previous: T) => T) => void;
type Updaters = {
  queueReconcile: (set: Setter<OfficeAnimationTriggerState>, agents: AgentState[]) => void;
  queueDanceFilter: (set: Setter<Record<string, number>>) => void;
};

/** What OfficeScreen does after the fix. */
const FIXED: Updaters = {
  queueReconcile: (set, agents) => {
    const nowMs = Date.now();
    set(
      createReplaySafeUpdater((previous) =>
        reconcileOfficeAnimationTriggerState({ state: previous, agents, nowMs }),
      ),
    );
  },
  queueDanceFilter: (set) => {
    const now = Date.now();
    set(createReplaySafeUpdater((previous) => dropExpiredUntilEntries(previous, now)));
  },
};

/** Content-equality and a captured clock alone: not enough while an agent is working. */
const IDENTITY_ONLY: Updaters = {
  queueReconcile: (set, agents) => {
    const nowMs = Date.now();
    set((previous) => reconcileOfficeAnimationTriggerState({ state: previous, agents, nowMs }));
  },
  queueDanceFilter: (set) => {
    const now = Date.now();
    set((previous) => dropExpiredUntilEntries(previous, now));
  },
};

/** The pattern before the fix: every application returns a new object. */
const BEFORE_FIX: Updaters = {
  queueReconcile: (set, agents) => {
    set((previous) => ({ ...reconcileOfficeAnimationTriggerState({ state: previous, agents }) }));
  },
  queueDanceFilter: (set) => {
    const now = Date.now();
    set((previous) => Object.fromEntries(Object.entries(previous).filter(([, until]) => until > now)));
  },
};

type SchedulerApi = {
  unstable_IdlePriority: number;
  unstable_runWithPriority: <T>(priority: number, callback: () => T) => T;
};
// React DOM's own scheduler instance (the package ships no type declarations).
const Scheduler = createRequire(import.meta.url)("scheduler") as SchedulerApi;

const runAtIdlePriority = (fn: () => void) => {
  // React gives an update made inside a "message" event, while the scheduler runs at idle
  // priority, the idle lane.
  Scheduler.unstable_runWithPriority(Scheduler.unstable_IdlePriority, () => {
    window.addEventListener("message", () => fn(), { once: true });
    window.dispatchEvent(new MessageEvent("message"));
  });
};

const measure = async (updaters: Updaters, agentsAfter: AgentState[]) => {
  // Every turn of the loop commits, so commits are counted (in a layout effect, not in render).
  const probe = {
    commits: 0,
    idleCommit: false,
    latest: null as OfficeAnimationTriggerState | null,
    latestAgents: [] as AgentState[],
    replaceAgents: null as ((agents: AgentState[]) => void) | null,
  };

  function OfficeLikeHarness() {
    const [agents, setAgents] = useState<AgentState[]>(IDLE_AGENTS);
    const [triggerState, setTriggerState] = useState(createOfficeAnimationTriggerState);
    const [danceUntil, setDanceUntil] = useState<Record<string, number>>({});
    const [, setPrepared] = useState<Record<string, number>>({});

    useLayoutEffect(() => {
      probe.commits += 1;
      probe.latest = triggerState;
      probe.latestAgents = agents;
      probe.replaceAgents = (next) => {
        probe.idleCommit = true;
        setAgents(next);
      };
    });

    useEffect(() => {
      updaters.queueReconcile(setTriggerState, agents);
      updaters.queueDanceFilter(setDanceUntil);
      if (probe.idleCommit) {
        probe.idleCommit = false;
        // The agent list changes again at normal priority (as fleet hydration does), queuing a
        // second reconcile behind the still-pending idle one.
        queueMicrotask(() => flushSync(() => setAgents((current) => [...current])));
      }
    }, [agents]);

    const animation = useMemo(
      () => ({ ...buildOfficeAnimationState({ state: triggerState, agents, nowMs: 0 }), danceUntil }),
      [triggerState, agents, danceUntil],
    );

    useEffect(() => {
      // Like OfficeScreen's phone/text prompt effects: the updater returns the previous value.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reproduces OfficeScreen's pattern on purpose
      setPrepared((previous) => previous);
    }, [animation.phoneCallByAgentId, animation.danceUntil]);

    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  root.render(createElement(OfficeLikeHarness));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = probe.commits;
  runAtIdlePriority(() => probe.replaceAgents?.(agentsAfter));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const commitsAfterIdleCommit = probe.commits - before;
  root.unmount();
  return {
    commitsAfterIdleCommit,
    latest: probe.latest,
    businessStatus: probe.latestAgents.find((agent) => agent.agentId === "business-operations")?.status,
  };
};

const watchUpdateDepthErrors = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    count: () => spy.mock.calls.filter((args) => String(args[0]).includes("Maximum update depth")).length,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OfficeScreen trigger-state updates under React's idle-lane replay", () => {
  it("reproduces the loop with the updater pattern used before the fix (control)", async () => {
    const errors = watchUpdateDepthErrors();
    const { commitsAfterIdleCommit } = await measure(BEFORE_FIX, IDLE_AGENTS.map((a) => ({ ...a })));
    expect(commitsAfterIdleCommit).toBeGreaterThan(1_000);
    expect(errors.count()).toBeGreaterThan(0);
  });

  it("still loops with content-equal updaters alone while Business is working (why replays are made safe)", async () => {
    // Re-applied to the older base state, the reconcile is a real change every time, so returning
    // the previous state when nothing changed cannot help; a new object is built on every render.
    const errors = watchUpdateDepthErrors();
    const { commitsAfterIdleCommit } = await measure(IDENTITY_ONLY, WORKING_AGENTS);
    expect(commitsAfterIdleCommit).toBeGreaterThan(1_000);
    expect(errors.count()).toBeGreaterThan(0);
  });

  it("settles with the fixed updaters when no agent is working", async () => {
    const errors = watchUpdateDepthErrors();
    const { commitsAfterIdleCommit } = await measure(FIXED, IDLE_AGENTS.map((a) => ({ ...a })));
    expect(commitsAfterIdleCommit).toBeLessThan(50);
    expect(errors.count()).toBe(0);
  });

  it("settles with the fixed updaters while Business is working, and shows and records its work", async () => {
    const errors = watchUpdateDepthErrors();
    const { commitsAfterIdleCommit, latest, businessStatus } = await measure(FIXED, WORKING_AGENTS);
    expect(commitsAfterIdleCommit).toBeLessThan(50);
    expect(errors.count()).toBe(0);
    expect(businessStatus).toBe("running");
    expect(latest?.workingUntilByAgentId["business-operations"]).toBeGreaterThan(0);
  });

  it("settles with the fixed updaters even when the clock moves on every read", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 7));
    const errors = watchUpdateDepthErrors();
    const { commitsAfterIdleCommit, businessStatus } = await measure(FIXED, WORKING_AGENTS);
    expect(commitsAfterIdleCommit).toBeLessThan(50);
    expect(errors.count()).toBe(0);
    expect(businessStatus).toBe("running");
  });
});
