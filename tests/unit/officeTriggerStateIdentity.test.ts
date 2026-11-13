import { describe, expect, it } from "vitest";

import type { AgentState, AgentStoreSeed } from "@/features/agents/state/store";
import type { EventFrame } from "@/lib/gateway/GatewayClient";
import {
  clearOfficeAnimationTriggerHold,
  createOfficeAnimationTriggerState,
  createReplaySafeUpdater,
  dropExpiredUntilEntries,
  keepOfficeAnimationTriggerStateIfUnchanged,
  reconcileOfficeAnimationTriggerState,
  reduceOfficeAnimationTriggerEvent,
} from "@/lib/office/eventTriggers";

// React may apply a queued state updater more than once: it replays updates when it rebases
// skipped lower-priority ones. These tests pin the property that keeps such replays harmless:
// an updater that changes nothing returns the previous state object.

const makeAgent = (
  overrides: Partial<AgentState> & Pick<AgentStoreSeed, "agentId" | "name" | "sessionKey">,
): AgentState => ({
  agentId: overrides.agentId,
  name: overrides.name,
  sessionKey: overrides.sessionKey,
  avatarSeed: overrides.avatarSeed ?? overrides.agentId,
  avatarUrl: overrides.avatarUrl ?? null,
  model: overrides.model ?? null,
  thinkingLevel: overrides.thinkingLevel ?? "high",
  status: overrides.status ?? "idle",
  sessionCreated: overrides.sessionCreated ?? false,
  awaitingUserInput: overrides.awaitingUserInput ?? false,
  hasUnseenActivity: overrides.hasUnseenActivity ?? false,
  outputLines: overrides.outputLines ?? [],
  lastResult: overrides.lastResult ?? null,
  lastDiff: overrides.lastDiff ?? null,
  runId: overrides.runId ?? null,
  runStartedAt: overrides.runStartedAt ?? null,
  streamText: overrides.streamText ?? null,
  thinkingTrace: overrides.thinkingTrace ?? null,
  latestOverride: overrides.latestOverride ?? null,
  latestOverrideKind: overrides.latestOverrideKind ?? null,
  lastAssistantMessageAt: overrides.lastAssistantMessageAt ?? null,
  lastActivityAt: overrides.lastActivityAt ?? null,
  latestPreview: overrides.latestPreview ?? null,
  lastUserMessage: overrides.lastUserMessage ?? null,
  draft: overrides.draft ?? "",
  queuedMessages: overrides.queuedMessages ?? [],
  sessionSettingsSynced: overrides.sessionSettingsSynced ?? false,
  historyLoadedAt: overrides.historyLoadedAt ?? null,
  historyFetchLimit: overrides.historyFetchLimit ?? null,
  historyFetchedCount: overrides.historyFetchedCount ?? null,
  historyMaybeTruncated: overrides.historyMaybeTruncated ?? false,
  toolCallingEnabled: overrides.toolCallingEnabled ?? false,
  showThinkingTraces: overrides.showThinkingTraces ?? true,
  transcriptEntries: overrides.transcriptEntries ?? [],
  transcriptRevision: overrides.transcriptRevision ?? 0,
  transcriptSequenceCounter: overrides.transcriptSequenceCounter ?? 0,
  sessionEpoch: overrides.sessionEpoch ?? 0,
  lastHistoryRequestRevision: overrides.lastHistoryRequestRevision ?? null,
  lastAppliedHistoryRequestId: overrides.lastAppliedHistoryRequestId ?? null,
});

const business = (overrides: Partial<AgentState> = {}) =>
  makeAgent({ agentId: "business-operations", name: "Business", sessionKey: "agent:business-operations:main", ...overrides });
const risk = (overrides: Partial<AgentState> = {}) =>
  makeAgent({ agentId: "risk-compliance", name: "Risk", sessionKey: "agent:risk-compliance:main", ...overrides });
const claims = (overrides: Partial<AgentState> = {}) =>
  makeAgent({ agentId: "claims-review", name: "Claims", sessionKey: "agent:claims-review:main", ...overrides });

describe("office trigger-state updaters keep the previous state when nothing changes", () => {
  it("reconcile replayed with the same inputs returns the same object (no agents yet)", () => {
    const first = reconcileOfficeAnimationTriggerState({
      state: createOfficeAnimationTriggerState(),
      agents: [],
      nowMs: 1_000,
    });
    let replayed = first;
    for (let i = 0; i < 20; i += 1) {
      replayed = reconcileOfficeAnimationTriggerState({ state: replayed, agents: [], nowMs: 1_000 });
    }
    expect(replayed).toBe(first);
  });

  it("reconcile replayed with the same inputs returns the same object while agents are working", () => {
    const agents = [
      business({ status: "running", runId: "RUN-B" }),
      risk({ status: "error" }),
      claims(),
    ];
    const first = reconcileOfficeAnimationTriggerState({
      state: createOfficeAnimationTriggerState(),
      agents,
      nowMs: 5_000,
    });
    expect(first.workingUntilByAgentId["business-operations"]).toBeGreaterThan(5_000);
    const replayed = reconcileOfficeAnimationTriggerState({ state: first, agents, nowMs: 5_000 });
    expect(replayed).toBe(first);
  });

  it("reconcile still records genuine changes", () => {
    const idle = reconcileOfficeAnimationTriggerState({
      state: createOfficeAnimationTriggerState(),
      agents: [business(), risk()],
      nowMs: 1_000,
    });
    // Business starts working: its working latch is recorded.
    const working = reconcileOfficeAnimationTriggerState({
      state: idle,
      agents: [business({ status: "running", runId: "RUN-B" }), risk()],
      nowMs: 1_000,
    });
    expect(working).not.toBe(idle);
    expect(working.workingUntilByAgentId["business-operations"]).toBeGreaterThan(1_000);
    // Time moves on while it is still working: the latch is refreshed.
    const later = reconcileOfficeAnimationTriggerState({
      state: working,
      agents: [business({ status: "running", runId: "RUN-B" }), risk()],
      nowMs: 9_000,
    });
    expect(later).not.toBe(working);
    expect(later.workingUntilByAgentId["business-operations"]).toBeGreaterThan(9_000);
    // A person asks for something that the office animates.
    const directive = reconcileOfficeAnimationTriggerState({
      state: later,
      agents: [business({ lastUserMessage: "Check GitHub for pull requests." }), risk()],
      nowMs: 9_000,
    });
    expect(directive).not.toBe(later);
    expect(directive.githubHoldByAgentId["business-operations"]).toBe(true);
  });

  it("clearing a hold that is not set keeps the state; clearing a real hold still clears it", () => {
    const empty = createOfficeAnimationTriggerState();
    for (const hold of ["github", "qa", "call", "text"] as const) {
      expect(clearOfficeAnimationTriggerHold({ state: empty, hold, agentId: "business-operations" })).toBe(empty);
    }
    const held = reconcileOfficeAnimationTriggerState({
      state: empty,
      agents: [business({ lastUserMessage: "Check GitHub for pull requests." })],
      nowMs: 2_000,
    });
    expect(held.githubHoldByAgentId["business-operations"]).toBe(true);
    const cleared = clearOfficeAnimationTriggerHold({ state: held, hold: "github", agentId: "business-operations" });
    expect(cleared).not.toBe(held);
    expect(cleared.githubHoldByAgentId["business-operations"]).toBeUndefined();
  });

  it("an event that changes nothing keeps the state; a real agent frame records activity", () => {
    const agents = [business(), risk(), claims()];
    const state = reconcileOfficeAnimationTriggerState({
      state: createOfficeAnimationTriggerState(),
      agents,
      nowMs: 3_000,
    });
    const unrelated: EventFrame = { type: "event", event: "unrelated", payload: {} };
    expect(reduceOfficeAnimationTriggerEvent({ state, event: unrelated, agents, nowMs: 3_000 })).toBe(state);
    // The operations feed's Business/Risk frames still animate the office.
    const start: EventFrame = {
      type: "event",
      event: "agent",
      payload: { runId: "RUN-R", sessionKey: "agent:risk-compliance:main", stream: "lifecycle", data: { phase: "start" } },
    };
    const animated = reduceOfficeAnimationTriggerEvent({ state, event: start, agents, nowMs: 3_000 });
    expect(animated).not.toBe(state);
    expect(animated.workingUntilByAgentId["risk-compliance"]).toBeGreaterThan(3_000);
    // Replaying that same queued update (same event, same clock) changes nothing further.
    expect(reduceOfficeAnimationTriggerEvent({ state: animated, event: start, agents, nowMs: 3_000 })).toBe(animated);
  });

  it("dropExpiredUntilEntries keeps the map when nothing expired and drops expired entries otherwise", () => {
    const map = { "business-operations": 10_000, "risk-compliance": 20_000 };
    expect(dropExpiredUntilEntries(map, 5_000)).toBe(map);
    expect(dropExpiredUntilEntries({}, 5_000)).toEqual({});
    expect(dropExpiredUntilEntries(map, 15_000)).toEqual({ "risk-compliance": 20_000 });
  });

  it("a replay-safe updater re-applied to the same state returns the same object", () => {
    const agents = [business({ status: "running", runId: "RUN-B" }), risk()];
    const base = createOfficeAnimationTriggerState();
    let computations = 0;
    const updater = createReplaySafeUpdater((previous: typeof base) => {
      computations += 1;
      return reconcileOfficeAnimationTriggerState({ state: previous, agents, nowMs: 4_000 });
    });
    // React re-applies the queued update to the same older base on every render while an
    // idle-lane update is pending; each application must give the same object.
    const first = updater(base);
    expect(first).not.toBe(base);
    expect(updater(base)).toBe(first);
    expect(updater(base)).toBe(first);
    expect(computations).toBe(1);
    // Applied to a different state (after the pending update commits), it computes again.
    const rebased = updater(first);
    expect(rebased).toBe(first);
    expect(computations).toBe(2);
  });

  it("compares content, not identity", () => {
    const state = createOfficeAnimationTriggerState();
    const copy = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(keepOfficeAnimationTriggerStateIfUnchanged(state, copy)).toBe(state);
    const changed = { ...copy, deskHoldByAgentId: { "business-operations": true } };
    expect(keepOfficeAnimationTriggerStateIfUnchanged(state, changed)).toBe(changed);
    // The first cleaning cue (an array growing from empty) is a change, and so is losing one.
    const cue = { id: "cue-1", agentId: "business-operations", agentName: "Business", ts: 1_000 };
    const withCue = { ...state, cleaningCues: [cue] };
    expect(keepOfficeAnimationTriggerStateIfUnchanged(state, withCue)).toBe(withCue);
    expect(keepOfficeAnimationTriggerStateIfUnchanged(withCue, state)).toBe(state);
    expect(keepOfficeAnimationTriggerStateIfUnchanged(withCue, { ...state, cleaningCues: [{ ...cue }] })).toBe(withCue);
  });
});
