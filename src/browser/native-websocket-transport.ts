import type { ConnectionTransport } from "@cloudflare/puppeteer";

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Puppeteer's Node transport imports the `ws` package when `nodejs_compat`
 * exposes `process.version`. Cloudflare Workers cannot use that Node socket
 * implementation, so external CDP endpoints need a small native-WebSocket
 * transport passed explicitly to `puppeteer.connect`.
 */
export async function createNativeWebSocketTransport(
  url: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<ConnectionTransport> {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    throw new Error("The browser WebSocket URL could not be opened.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("The browser WebSocket connection timed out."));
    }, timeoutMs);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      callback();
    };
    const handleOpen = (): void => finish(resolve);
    const handleError = (): void =>
      finish(() => reject(new Error("The browser WebSocket connection failed.")));

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
  });

  return new NativeWebSocketTransport(socket);
}

class NativeWebSocketTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.onmessage?.(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.onmessage?.(new TextDecoder().decode(event.data));
      }
    });
    socket.addEventListener("close", () => this.onclose?.());
    socket.addEventListener("error", () => {
      // The close event is Puppeteer's transport-level signal. Do not surface
      // browser connection details or bearer URLs through an error message.
    });
  }

  send(message: string): void {
    this.socket.send(message);
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.close();
    }
  }
}
