import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatMessageViaStudio } from "@/features/agents/operations/chatSendOperation";
import type { AgentState } from "@/features/agents/state/store";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { CustomRuntimeProvider } from "@/lib/runtime/custom/provider";
import { applySessionSettingMutation } from "@/features/agents/state/sessionSettingsMutations";

const RUNTIME_URL = "http://localhost:7770";
const SESSION_KEY = "agent:claims-review:main";

type ProxyBody = { runtimeUrl: string; pathname: string; method: string; body?: unknown };

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Stands in for /api/runtime/custom -> a single-model runtime like the claims adapter. */
const installRuntimeFetch = () => {
  const proxied: ProxyBody[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ProxyBody;
    proxied.push(body);
    switch (body.pathname) {
      case "/health":
        return jsonResponse({ ok: true, status: "ok" });
      case "/state":
        return jsonResponse({
          identity: {
            name: "Claims Review Agent",
            role: "claims-reviewer",
            lane: "claims-review",
            model_id: "qwen3:8b",
          },
        });
      case "/registry":
        return jsonResponse({ models: { "qwen3:8b": {} } });
      case "/v1/chat/completions":
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "# Preliminary claim review - CLM-1004" } }],
        });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { proxied, fetchMock };
};

const createProvider = () =>
  new CustomRuntimeProvider({} as unknown as GatewayClient, RUNTIME_URL, { id: "custom" });

const createUnsyncedAgent = (overrides?: Partial<AgentState>): AgentState =>
  ({
    agentId: "claims-review",
    name: "Claims Review Agent",
    sessionKey: SESSION_KEY,
    status: "idle",
    sessionCreated: false,
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
    sessionSettingsSynced: false,
    historyLoadedAt: null,
    historyFetchLimit: null,
    historyFetchedCount: null,
    historyMaybeTruncated: false,
    toolCallingEnabled: true,
    showThinkingTraces: true,
    model: null,
    thinkingLevel: null,
    avatarSeed: "seed-1",
    avatarUrl: null,
    ...(overrides ?? {}),
  }) as AgentState;

describe("CustomRuntimeProvider sessions.patch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts the initial sync with no overrides and resolves the runtime default model", async () => {
    installRuntimeFetch();
    const provider = createProvider();
    const result = await provider.call("sessions.patch", {
      key: SESSION_KEY,
      model: null,
      thinkingLevel: null,
    });
    expect(result).toEqual({
      ok: true,
      key: SESSION_KEY,
      resolved: { modelProvider: "custom", model: "qwen3:8b" },
    });
  });

  it("accepts the runtime's own model with or without the provider prefix", async () => {
    installRuntimeFetch();
    const provider = createProvider();
    await expect(
      provider.call("sessions.patch", { key: SESSION_KEY, model: "custom/qwen3:8b" })
    ).resolves.toMatchObject({ ok: true, resolved: { model: "qwen3:8b" } });
    await expect(
      provider.call("sessions.patch", { key: SESSION_KEY, model: "qwen3:8b" })
    ).resolves.toMatchObject({ ok: true, resolved: { model: "qwen3:8b" } });
  });

  it("rejects a model the runtime does not offer", async () => {
    installRuntimeFetch();
    const provider = createProvider();
    await expect(
      provider.call("sessions.patch", { key: SESSION_KEY, model: "openai/gpt-5" })
    ).rejects.toThrow('Custom runtime does not offer model "openai/gpt-5". Available: qwen3:8b.');
  });

  it("rejects thinking-level and exec permission settings", async () => {
    installRuntimeFetch();
    const provider = createProvider();
    await expect(
      provider.call("sessions.patch", { key: SESSION_KEY, thinkingLevel: "high" })
    ).rejects.toThrow("Custom runtime does not support session settings: thinkingLevel.");
    await expect(
      provider.call("sessions.patch", {
        key: SESSION_KEY,
        execHost: "gateway",
        execSecurity: "full",
        execAsk: "off",
      })
    ).rejects.toThrow(
      "Custom runtime does not support session settings: execHost, execSecurity, execAsk."
    );
  });

  it("requires a session key", async () => {
    installRuntimeFetch();
    await expect(createProvider().call("sessions.patch", { model: null })).rejects.toThrow(
      "Custom runtime requires key for sessions.patch."
    );
  });
});

describe("chat send through a custom runtime with an unsynced session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not push the store's default thinking level on the initial sync, then delivers the chat", async () => {
    const { proxied } = installRuntimeFetch();
    const provider = createProvider();
    const callSpy = vi.spyOn(provider, "call");
    // The agent store falls back to thinkingLevel "high" when a runtime reports none.
    const agent = createUnsyncedAgent({
      thinkingLevel: "high",
      sessionExecHost: "gateway",
      sessionExecSecurity: "full",
      sessionExecAsk: "off",
    });
    const dispatch = vi.fn();

    await sendChatMessageViaStudio({
      client: provider,
      dispatch,
      getAgent: () => agent,
      agentId: agent.agentId,
      sessionKey: SESSION_KEY,
      message: "Review CLM-1004",
      clearRunTracking: vi.fn(),
    });

    expect(callSpy.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "chat.send"]);
    expect(callSpy).toHaveBeenCalledWith("sessions.patch", { key: SESSION_KEY, model: null });

    const chatRequest = proxied.find((entry) => entry.pathname === "/v1/chat/completions");
    expect(chatRequest).toMatchObject({
      runtimeUrl: RUNTIME_URL,
      method: "POST",
      body: {
        model: "qwen3:8b",
        session_id: SESSION_KEY,
        messages: [{ role: "user", content: "Review CLM-1004" }],
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateAgent",
        agentId: "claims-review",
        patch: { sessionSettingsSynced: true, sessionCreated: true },
      })
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "appendOutput",
        agentId: "claims-review",
        line: "# Preliminary claim review - CLM-1004",
      })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ status: "error" }) })
    );
  });

  it("still syncs a selected model and delivers the chat", async () => {
    const { proxied } = installRuntimeFetch();
    const provider = createProvider();
    const callSpy = vi.spyOn(provider, "call");
    const agent = createUnsyncedAgent({ model: "custom/qwen3:8b", thinkingLevel: "high" });

    await sendChatMessageViaStudio({
      client: provider,
      dispatch: vi.fn(),
      getAgent: () => agent,
      agentId: agent.agentId,
      sessionKey: SESSION_KEY,
      message: "Review CLM-1004",
      clearRunTracking: vi.fn(),
    });

    expect(callSpy).toHaveBeenCalledWith("sessions.patch", {
      key: SESSION_KEY,
      model: "custom/qwen3:8b",
    });
    expect(proxied.some((entry) => entry.pathname === "/v1/chat/completions")).toBe(true);
  });
});

describe("explicit unsupported session setting changes on a custom runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an explicit thinking-level change and reports the error", async () => {
    const { proxied } = installRuntimeFetch();
    const provider = createProvider();
    const dispatch = vi.fn();

    await applySessionSettingMutation({
      agents: [createUnsyncedAgent({ thinkingLevel: null })],
      dispatch,
      client: provider as unknown as GatewayClient,
      agentId: "claims-review",
      sessionKey: SESSION_KEY,
      field: "thinkingLevel",
      value: "low",
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "appendOutput",
        line: expect.stringContaining(
          "Custom runtime does not support session settings: thinkingLevel."
        ),
      })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ patch: { sessionSettingsSynced: true, sessionCreated: true } })
    );
    expect(proxied.some((entry) => entry.pathname === "/v1/chat/completions")).toBe(false);
  });
});

describe("custom runtime session discovery and model metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the agent's session under its main session key", async () => {
    installRuntimeFetch();
    const result = await createProvider().call<{ sessions: Array<{ key: string; model: string }> }>(
      "sessions.list",
      { agentId: "claims-review" }
    );
    expect(result.sessions.map((session) => session.key)).toEqual([SESSION_KEY]);
    expect(result.sessions[0]?.model).toBe("qwen3:8b");
  });

  it("marks models as not supporting configurable reasoning", async () => {
    installRuntimeFetch();
    const result = await createProvider().call<{ models: Array<{ id: string; reasoning?: boolean }> }>(
      "models.list",
      {}
    );
    expect(result.models).toEqual([
      expect.objectContaining({ id: "qwen3:8b", provider: "custom", reasoning: false }),
    ]);
  });
});
