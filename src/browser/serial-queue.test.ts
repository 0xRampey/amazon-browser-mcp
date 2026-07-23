import { describe, expect, it } from "vitest";

import { QueueFullError, SerialQueue } from "./serial-queue";
import {
  AmazonOperationError,
  amazonInternalOperationSchema,
} from "../sites/amazon/operations";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("SerialQueue", () => {
  it("runs operations one at a time in FIFO order", async () => {
    const queue = new SerialQueue(4);
    const firstGate = deferred<void>();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const run = (name: string, gate?: Promise<void>) =>
      queue.run(async () => {
        events.push(`${name}:start`);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        events.push(`${name}:end`);
        return name;
      });

    const first = run("first", firstGate.promise);
    const second = run("second");
    const third = run("third");

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.depth).toBe(3);

    firstGate.resolve();

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(maximumActive).toBe(1);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ]);
    expect(queue.depth).toBe(0);
  });

  it("rejects only the failed entry and continues draining", async () => {
    const queue = new SerialQueue(3);
    const expectedFailure = new Error("private upstream detail");

    const failed = queue.run(async () => {
      throw expectedFailure;
    });
    const recovered = queue.run(() => "recovered");

    await expect(failed).rejects.toBe(expectedFailure);
    await expect(recovered).resolves.toBe("recovered");
    expect(queue.depth).toBe(0);
  });

  it("caps total outstanding work and accepts work after capacity frees", async () => {
    const queue = new SerialQueue(2);
    const gate = deferred<void>();

    const first = queue.run(() => gate.promise);
    const second = queue.run(() => "second");

    expect(queue.depth).toBe(2);
    expect(() => queue.run(() => "overflow")).toThrow(
      expect.objectContaining({ name: "QueueFullError", maxDepth: 2 }),
    );

    gate.resolve();
    await first;
    await expect(second).resolves.toBe("second");
    await expect(queue.run(() => "after")).resolves.toBe("after");
  });

  it("validates queue capacity", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SerialQueue(invalid)).toThrow(RangeError);
    }

    expect(() => new SerialQueue(1)).not.toThrow();
    expect(new QueueFullError(1).message).not.toContain("1");
  });
});

describe("Amazon internal operation boundary", () => {
  it("accepts only the four reviewed operation shapes", () => {
    const valid = [
      { action: "session_status" },
      {
        action: "list_orders",
        orderedFrom: "2026-01-01",
        orderedTo: "2026-01-31",
        statuses: ["delivered"],
        limit: 20,
        maxPages: 3,
      },
      { action: "get_order", orderId: "123-1234567-1234567" },
      {
        action: "find_orders",
        amount: "41.92",
        currency: "USD",
        dateWindowDays: 14,
        amountTolerance: "0.00",
        limit: 10,
        maxPages: 3,
      },
    ];

    for (const operation of valid) {
      expect(amazonInternalOperationSchema.safeParse(operation).success).toBe(true);
    }

    const invalid = [
      { action: "open_url", url: "https://www.amazon.com/checkout" },
      { action: "session_status", extra: true },
      {
        action: "list_orders",
        orderedFrom: "2026-02-01",
        orderedTo: "2026-01-01",
        limit: 20,
        maxPages: 3,
      },
      { action: "get_order", orderId: "not-an-order-id" },
      {
        action: "find_orders",
        currency: "USD",
        dateWindowDays: 14,
        amountTolerance: "0.00",
        limit: 10,
        maxPages: 3,
      },
    ];

    for (const operation of invalid) {
      expect(amazonInternalOperationSchema.safeParse(operation).success).toBe(false);
    }
  });

  it("maps safe service errors to fixed public details", () => {
    const error = new AmazonOperationError("LOGIN_REQUIRED");

    expect(error).toMatchObject({
      code: "LOGIN_REQUIRED",
      message: "Amazon sign-in is required.",
      userActionRequired: true,
    });
  });
});
