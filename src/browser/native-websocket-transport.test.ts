import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeWebSocketTransport } from "./native-websocket-transport";

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.autoOpen = true;
});

describe("native Worker WebSocket transport", () => {
  it("connects, sends CDP messages, and forwards socket events", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const transport = await createNativeWebSocketTransport(
      "wss://connect.browserbase.com?signingKey=private",
      100,
    );
    const socket = FakeWebSocket.instances[0]!;
    const onmessage = vi.fn();
    const onclose = vi.fn();
    transport.onmessage = onmessage;
    transport.onclose = onclose;

    transport.send('{"id":1}');
    socket.dispatchEvent(new MessageEvent("message", { data: '{"id":1,"result":{}}' }));
    transport.close();

    expect(socket.sent).toEqual(['{"id":1}']);
    expect(onmessage).toHaveBeenCalledWith('{"id":1,"result":{}}');
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("fails closed when the native socket never opens", async () => {
    FakeWebSocket.autoOpen = false;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    await expect(
      createNativeWebSocketTransport(
        "wss://connect.browserbase.com?signingKey=private",
        1,
      ),
    ).rejects.toThrow("timed out");

    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static autoOpen = true;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
