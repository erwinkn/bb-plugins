import { afterEach, describe, expect, it, vi } from "vitest";
import { bindClientLog, installCrashReporting, reportCrash } from "@/lib/client-log";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call: vi.fn(async () => null) }) }));

const RO_NOTICE = "ResizeObserver loop completed with undelivered notifications.";

const teardowns: Array<() => void> = [];

function setup() {
  const rpc = { call: vi.fn(async () => null) };
  const unbindLog = bindClientLog(rpc);
  const uninstall = installCrashReporting(() => ({ phase: "file-opener" }));
  teardowns.push(uninstall, unbindLog);
  return rpc;
}

function windowError(init: { message: string; error?: unknown }): Event {
  const event = new Event("error");
  Object.defineProperties(event, {
    message: { value: init.message },
    error: { value: init.error ?? null },
  });
  return event;
}

function windowRejection(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

/** Flushes the deduper (on unbind) and the queued RPC calls. */
async function settle(): Promise<void> {
  while (teardowns.length > 0) teardowns.pop()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
});

describe("installCrashReporting", () => {
  it("does not forward the ResizeObserver loop notice to the client log", async () => {
    const rpc = setup();
    window.dispatchEvent(windowError({ message: RO_NOTICE }));
    window.dispatchEvent(windowError({ message: "ResizeObserver loop limit exceeded" }));
    await settle();
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("still forwards a normal window error", async () => {
    const rpc = setup();
    window.dispatchEvent(windowError({ message: "boom", error: new Error("boom") }));
    await settle();
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith(
      "clientLog",
      expect.objectContaining({
        level: "error",
        event: "crash",
        fields: expect.objectContaining({ phase: "file-opener:window", message: "boom" }),
      }),
    );
  });

  it("drops a ResizeObserver rejection but still forwards a normal one", async () => {
    const rpc = setup();
    window.dispatchEvent(windowRejection(new Error(RO_NOTICE)));
    window.dispatchEvent(windowRejection(new Error("async exploded")));
    await settle();
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith(
      "clientLog",
      expect.objectContaining({
        level: "error",
        event: "crash",
        fields: expect.objectContaining({ phase: "file-opener:unhandledrejection", message: "async exploded" }),
      }),
    );
  });
});

describe("reportCrash", () => {
  it("still reports a ResizeObserver notice from an error boundary as warn", async () => {
    const rpc = setup();
    reportCrash({ phase: "file-opener" }, new Error(RO_NOTICE));
    await settle();
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledWith(
      "clientLog",
      expect.objectContaining({
        level: "warn",
        event: "crash",
        fields: expect.objectContaining({ phase: "file-opener", message: RO_NOTICE }),
      }),
    );
  });
});
