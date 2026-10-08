import { describe, expect, it, vi } from "vitest";
import { withWriteTimeout, WriteUnconfirmedError, WRITE_UNCONFIRMED_MS } from "../lib/write-timeout";

describe("W239 withWriteTimeout", () => {
  it("passes an answer through, and fails a write with no answer as unconfirmed, without cancelling it", async () => {
    vi.useFakeTimers();
    try {
      await expect(withWriteTimeout(Promise.resolve("saved"))).resolves.toBe("saved");
      let answer!: (v: string) => void;
      const write = new Promise<string>((resolve) => (answer = resolve));
      const timed = withWriteTimeout(write);
      const outcome = expect(timed).rejects.toBeInstanceOf(WriteUnconfirmedError);
      await vi.advanceTimersByTimeAsync(WRITE_UNCONFIRMED_MS);
      await outcome;
      answer("late");
      await expect(write).resolves.toBe("late");
      // A failure after giving up is not left unhandled.
      const failing = Promise.reject(new Error("dropped"));
      const quiet = withWriteTimeout(failing, 10);
      await expect(quiet).rejects.toThrow("dropped");
    } finally {
      vi.useRealTimers();
    }
  });
});
