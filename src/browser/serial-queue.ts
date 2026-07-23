/**
 * A small, in-memory FIFO used to serialize access to a single browser
 * context. `maxDepth` counts both the running operation and queued operations.
 *
 * Durable Object instances process requests concurrently whenever a handler
 * awaits. Keeping this queue on the instance therefore prevents two requests
 * from operating on the same Browserbase context at once without holding the
 * Durable Object's input gate with `blockConcurrencyWhile`.
 */
export class SerialQueue {
  readonly maxDepth: number;

  private readonly pending: QueueEntry<unknown>[] = [];
  private running = false;

  constructor(maxDepth: number) {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError("maxDepth must be a positive safe integer");
    }

    this.maxDepth = maxDepth;
  }

  /** The total number of running and waiting operations. */
  get depth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /**
   * Enqueue one operation. The returned promise adopts the operation's result.
   * A rejection is isolated to that entry and never poisons later entries.
   */
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.depth >= this.maxDepth) {
      throw new QueueFullError(this.maxDepth);
    }

    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({
        operation,
        resolve,
        reject,
      } as QueueEntry<unknown>);
    });

    void this.drain();
    return result;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry) {
          continue;
        }

        try {
          entry.resolve(await entry.operation());
        } catch (error: unknown) {
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;

      // An entry cannot normally arrive between the empty check above and this
      // finally block because no await occurs there. This guard makes the queue
      // resilient if that implementation detail changes later.
      if (this.pending.length > 0) {
        void this.drain();
      }
    }
  }
}

export class QueueFullError extends Error {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super("The serial operation queue is full");
    this.name = "QueueFullError";
    this.maxDepth = maxDepth;
  }
}

interface QueueEntry<T> {
  readonly operation: () => Promise<T> | T;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}
