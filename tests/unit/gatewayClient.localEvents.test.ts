import { describe, expect, it, vi } from "vitest";

import { GatewayClient, type EventFrame } from "@/lib/gateway/GatewayClient";

describe("gateway client local events", () => {
  it("delivers local frames to the office's handlers without a sequence number", () => {
    const client = new GatewayClient();
    const received: EventFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    client.dispatchLocalEvent({ type: "event", event: "agent", seq: 99, payload: { runId: "r" } });
    client.dispatchLocalEvent({ type: "req" } as unknown as EventFrame);
    expect(received).toEqual([{ type: "event", event: "agent", payload: { runId: "r" } }]);
  });

  it("keeps one source per key and stops every source on disconnect without a WebSocket", () => {
    const client = new GatewayClient();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const unregisterFirst = client.registerLocalEventSource("feed", first);
    client.registerLocalEventSource("feed", second);
    expect(first).toHaveBeenCalledTimes(1); // replaced
    unregisterFirst(); // must not remove the newer source
    client.registerLocalEventSource("other", other);
    client.disconnect();
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    client.disconnect();
    expect(second).toHaveBeenCalledTimes(1); // already stopped and removed
  });
});
