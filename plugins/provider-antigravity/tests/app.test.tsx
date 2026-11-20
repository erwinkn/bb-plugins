// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SignInFlow, Status, UsageState } from "../src/contract";

// What the Settings section asks the plugin's server, and how often: on mount,
// on remount, while it sits open, and around sign-in, refresh and sign-out.
// The queries are the plugin's only readers, with no timers of their own, so
// an open section sends nothing until something changes.

type Server = {
  status: Status;
  usage: Record<string, UsageState>;
  usageDelayMs: number;
  // Answer for the next forced read (a Refresh click), with its own delay.
  forced: { delayMs: number; answer: UsageState } | null;
  nextStatus: Status | null;
  // Answer for the next ordinary read, with its own delay.
  slowRead: { delayMs: number; answer: UsageState } | null;
  // Answer for the next status read only: a status that is out of date.
  staleStatus: Status | null;
  // Answer for every status read after the first, delayed: a read that is still
  // in flight when the user signs in or out.
  slowStatus: { delayMs: number; answer: Status } | null;
  statusCalls: number;
};

const ok = (email: string, used: number): UsageState => ({
  status: "ok",
  accountEmail: email,
  windows: [{ label: "Gemini 5h", usedPercent: used, resetsAt: null }],
  fetchedAt: "2026-11-20T19:00:00.000Z",
});
const signedIn = (email: string | null, flow: SignInFlow | null = null): Status => ({
  installed: true,
  signedIn: true,
  email,
  flow,
});
const waitingFlow: SignInFlow = {
  id: "flow-1",
  phase: "waiting",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
  message: null,
  active: true,
};

let app: CapturedPluginApp;
let server: Server;
const slots: RenderedSlot[] = [];

function handlers() {
  return {
    status: async () => {
      server.statusCalls += 1;
      if (server.slowStatus && server.statusCalls > 1) {
        const { delayMs, answer } = server.slowStatus;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return answer;
      }
      const stale = server.staleStatus;
      server.staleStatus = null;
      return stale ?? server.status;
    },
    usage: async (raw: unknown) => {
      const input = raw as { force?: boolean } | null;
      if (input?.force && server.forced) {
        const { delayMs, answer } = server.forced;
        server.forced = null;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return answer;
      }
      if (server.slowRead) {
        const { delayMs, answer } = server.slowRead;
        server.slowRead = null;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return answer;
      }
      const email = server.status.email ?? "";
      if (server.usageDelayMs) await new Promise((resolve) => setTimeout(resolve, server.usageDelayMs));
      const answer = server.usage[email];
      if (!answer) throw new Error(`no usage for ${email}`);
      return answer;
    },
    signInStart: () => {
      server.status = { ...server.status, flow: waitingFlow };
      return server.status;
    },
    signInSubmit: () => {
      server.status = server.nextStatus ?? server.status;
      return server.status;
    },
    signInCancel: () => {
      server.status = { ...server.status, flow: null };
      return server.status;
    },
    signOut: () => {
      server.status = { installed: true, signedIn: false, email: null, flow: null };
      return server.status;
    },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  server = {
    status: signedIn("a@example.com"),
    usage: { "a@example.com": ok("a@example.com", 10), "b@example.com": ok("b@example.com", 70) },
    usageDelayMs: 0,
    forced: null,
    nextStatus: null,
    slowRead: null,
    staleStatus: null,
    slowStatus: null,
    statusCalls: 0,
  };
  // A fresh import gives a fresh query cache: each test is a first page load.
  app = await loadPluginApp(() => import("../app"));
});

afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mount() {
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: handlers() });
  slots.push(slot);
  await advance(100);
  return slot;
}

const counts = (slot: RenderedSlot) => {
  const byMethod: Record<string, number> = {};
  for (const call of slot.inspection.rpcCalls) byMethod[call.method] = (byMethod[call.method] ?? 0) + 1;
  return byMethod;
};

const click = async (slot: RenderedSlot, name: string) => {
  fireEvent.click(slot.getByText(name));
  await advance(100);
};

describe("request rate of the Settings section", () => {
  it("reads status and usage once on mount, then stays quiet while open", async () => {
    const slot = await mount();
    expect(slot.getByText("Signed in as a@example.com")).toBeTruthy();
    expect(slot.getByText(/10% used/u)).toBeTruthy();
    expect(counts(slot)).toEqual({ status: 1, usage: 1 });
    await advance(10 * 60_000);
    expect(counts(slot)).toEqual({ status: 1, usage: 1 });
  });

  it("remounting inside the stale window reads nothing, after it re-reads each query once", async () => {
    const first = await mount();
    first.unmount();
    slots.length = 0;
    const second = await mount();
    expect(counts(second)).toEqual({});
    expect(second.getByText(/10% used/u)).toBeTruthy();
    second.unmount();
    slots.length = 0;

    await advance(31_000);
    const third = await mount();
    // The cached limits show at once; one read of each query refreshes them.
    expect(counts(third)).toEqual({ status: 1, usage: 1 });
    expect(third.getByText(/10% used/u)).toBeTruthy();
  });

  it("a Refresh click is one forced usage read", async () => {
    const slot = await mount();
    server.usage["a@example.com"] = ok("a@example.com", 55);
    await click(slot, "Refresh");
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "usage").map((call) => call.input)).toEqual([
      {},
      { force: true },
    ]);
    expect(counts(slot)).toEqual({ status: 1, usage: 2 });
    expect(slot.getByText(/55% used/u)).toBeTruthy();
  });

  it("starting a flow reads nothing else; finishing it re-reads usage once, not status", async () => {
    const slot = await mount();
    await click(slot, "Switch account");
    expect(counts(slot)).toEqual({ status: 1, usage: 1, signInStart: 1 });

    server.nextStatus = signedIn("b@example.com", {
      id: "flow-1",
      phase: "succeeded",
      authorizationUrl: null,
      message: "Signed in to Antigravity.",
      active: false,
    });
    fireEvent.change(slot.getByLabelText("Authorization code"), { target: { value: "4/code" } });
    await click(slot, "Sign in");
    expect(counts(slot)).toEqual({ status: 1, usage: 2, signInStart: 1, signInSubmit: 1 });
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    expect(slot.queryByText(/10% used/u)).toBeNull();
    await advance(5 * 60_000);
    expect(counts(slot)).toEqual({ status: 1, usage: 2, signInStart: 1, signInSubmit: 1 });
  });

  it("cancelling a flow reads no usage", async () => {
    const slot = await mount();
    await click(slot, "Switch account");
    await click(slot, "Cancel");
    expect(counts(slot)).toEqual({ status: 1, usage: 1, signInStart: 1, signInCancel: 1 });
  });

  it("signing out reads no usage and drops the cached limits", async () => {
    const slot = await mount();
    await click(slot, "Sign out");
    await click(slot, "Sign out");
    expect(counts(slot)).toEqual({ status: 1, usage: 1, signOut: 1 });
    expect(slot.getByText("Not signed in")).toBeTruthy();
    expect(slot.queryByText(/% used/u)).toBeNull();
    await advance(5 * 60_000);
    expect(counts(slot)).toEqual({ status: 1, usage: 1, signOut: 1 });
  });
});

describe("usage per account", () => {
  it("never shows the previous account's limits while the new account loads", async () => {
    const slot = await mount();
    expect(slot.getByText(/10% used/u)).toBeTruthy();
    server.usageDelayMs = 5_000;
    server.nextStatus = signedIn("b@example.com");
    await click(slot, "Switch account");
    fireEvent.change(slot.getByLabelText("Authorization code"), { target: { value: "4/code" } });
    await click(slot, "Sign in");
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.queryByText(/10% used/u)).toBeNull();
    expect(slot.getByText("Reading Antigravity quota…")).toBeTruthy();
    await advance(5_000);
    expect(slot.getByText(/70% used/u)).toBeTruthy();
  });

  it("an account that changed behind the page's back starts from an empty entry", async () => {
    (await mount()).unmount();
    slots.length = 0;
    // Another tab or the CLI signed in as b@example.com; the next open re-reads
    // status (stale after 30 s) and must not show a@example.com's cached limits.
    server.status = signedIn("b@example.com");
    server.usageDelayMs = 5_000;
    await advance(31_000);
    const slot = await mount();
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.queryByText(/10% used/u)).toBeNull();
    expect(slot.getByText("Reading Antigravity quota…")).toBeTruthy();
    await advance(5_000);
    expect(slot.getByText(/70% used/u)).toBeTruthy();
  });

  it("shows the new account's error, not the previous account's limits", async () => {
    const slot = await mount();
    delete server.usage["b@example.com"];
    server.nextStatus = signedIn("b@example.com");
    await click(slot, "Switch account");
    fireEvent.change(slot.getByLabelText("Authorization code"), { target: { value: "4/code" } });
    await click(slot, "Sign in");
    await advance(5_000);
    expect(slot.getByText("no usage for b@example.com")).toBeTruthy();
    expect(slot.queryByText(/10% used/u)).toBeNull();
  });

  it("a refresh answered for another account is never shown as the asking account's limits", async () => {
    const slot = await mount();
    server.usageDelayMs = 1_000;
    server.usage["a@example.com"] = ok("b@example.com", 99);
    fireEvent.click(slot.getByText("Refresh"));
    await advance(1_000);
    // The answer names b@example.com: it is never shown as a@example.com's limits.
    expect(slot.queryByText(/99% used/u)).toBeNull();
  });

  it.each([
    ["expired", { status: "expired" }, "Sign-in expired. Click Switch account to sign in again."],
    ["error", { status: "error", message: "agy crashed" }, "agy crashed"],
  ] as const)("a late %s answer to a refresh started under another account does not replace the new account's limits", async (_name, answer, text) => {
    const slot = await mount();
    server.forced = { delayMs: 3_000, answer };
    fireEvent.click(slot.getByText("Refresh"));
    await advance(100);
    server.nextStatus = signedIn("b@example.com");
    await click(slot, "Switch account");
    fireEvent.change(slot.getByLabelText("Authorization code"), { target: { value: "4/code" } });
    await click(slot, "Sign in");
    await advance(500);
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    await advance(3_000);
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    expect(slot.queryByText(text)).toBeNull();
  });

  async function signInAs(slot: RenderedSlot, email: string, button: string) {
    server.nextStatus = signedIn(email);
    await click(slot, button);
    fireEvent.change(slot.getByLabelText("Authorization code"), { target: { value: "4/code" } });
    await click(slot, "Sign in");
    await advance(500);
  }

  it.each([
    ["expired", { status: "expired" }, "Sign-in expired. Click Switch account to sign in again."],
    ["error", { status: "error", message: "agy crashed" }, "agy crashed"],
  ] as const)("a late %s answer from A does not replace A's fresh limits after A -> B -> A", async (_name, answer, text) => {
    const slot = await mount();
    server.forced = { delayMs: 10_000, answer };
    fireEvent.click(slot.getByText("Refresh"));
    await advance(100);
    await signInAs(slot, "b@example.com", "Switch account");
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    await signInAs(slot, "a@example.com", "Switch account");
    expect(slot.getByText("Signed in as a@example.com")).toBeTruthy();
    expect(slot.getByText(/10% used/u)).toBeTruthy();
    await advance(10_000);
    expect(slot.getByText(/10% used/u)).toBeTruthy();
    expect(slot.queryByText(text)).toBeNull();
  });

  it.each([
    ["expired", { status: "expired" }, "Sign-in expired. Click Switch account to sign in again."],
    ["error", { status: "error", message: "agy crashed" }, "agy crashed"],
  ] as const)("a late %s answer from A does not replace A's limits after sign-out, remount and sign-in as A", async (_name, answer, text) => {
    const first = await mount();
    server.forced = { delayMs: 10_000, answer };
    fireEvent.click(first.getByText("Refresh"));
    await advance(100);
    await click(first, "Sign out");
    await click(first, "Sign out");
    expect(first.getByText("Not signed in")).toBeTruthy();
    first.unmount();
    slots.splice(slots.indexOf(first), 1);
    const second = await mount();
    await signInAs(second, "a@example.com", "Sign in with Google");
    expect(second.getByText("Signed in as a@example.com")).toBeTruthy();
    expect(second.getByText(/10% used/u)).toBeTruthy();
    await advance(10_000);
    expect(second.getByText(/10% used/u)).toBeTruthy();
    expect(second.queryByText(text)).toBeNull();
  });

  it("a late ordinary read for A that names B does not overwrite B's fresher limits", async () => {
    // A's first read is slow and, when it lands, carries stale limits for B.
    server.slowRead = { delayMs: 10_000, answer: ok("b@example.com", 99) };
    const slot = await mount();
    await signInAs(slot, "b@example.com", "Switch account");
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    await advance(10_000);
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    expect(slot.queryByText(/99% used/u)).toBeNull();
  });

  it("never shows an ordinary usage answer that names another account", async () => {
    server.usage["a@example.com"] = ok("b@example.com", 99);
    const slot = await mount();
    await advance(5_000);
    expect(slot.getByText("Signed in as a@example.com")).toBeTruthy();
    expect(slot.queryByText(/99% used/u)).toBeNull();
  });

  it("a read that names another account re-reads the status and then shows that account's limits", async () => {
    // Credentials were swapped to B behind the page: the first status read is
    // out of date (A), the usage read already answers for B.
    server.status = signedIn("b@example.com");
    server.staleStatus = signedIn("a@example.com");
    const slot = await mount();
    await advance(5_000);
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    expect(slot.queryByText(/Checking which account/u)).toBeNull();
    expect(counts(slot).status).toBe(2);
  });

  it("a refresh that names another account re-reads the status and then shows that account's limits", async () => {
    const slot = await mount();
    expect(slot.getByText(/10% used/u)).toBeTruthy();
    server.status = signedIn("b@example.com");
    await click(slot, "Refresh");
    await advance(5_000);
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
    expect(slot.queryByText(/10% used/u)).toBeNull();
  });

  it("a mismatch that the status does not explain neither loops nor caches", async () => {
    server.usage["a@example.com"] = ok("b@example.com", 99);
    const slot = await mount();
    await advance(60_000);
    expect(slot.queryByText(/99% used/u)).toBeNull();
    // One status read on mount, one more because of the mismatch; the usage
    // read is not retried and nothing re-reads on its own.
    expect(counts(slot)).toEqual({ status: 2, usage: 1 });
  });

  it("a Refresh in flight turns the button off, so clicks do not stack reads", async () => {
    const slot = await mount();
    server.forced = { delayMs: 3_000, answer: ok("a@example.com", 55) };
    fireEvent.click(slot.getByText("Refresh"));
    await advance(100);
    // The button is off while the read runs, so a second click cannot start another.
    expect((slot.getByText("Refreshing…") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByText("Refreshing…"));
    await advance(3_000);
    expect(counts(slot)).toEqual({ status: 1, usage: 2 });
    expect(slot.getByText(/55% used/u)).toBeTruthy();
  });

  it("a status read still in flight cannot undo a finished sign-out", async () => {
    // The mismatch makes the page re-read its status; that read is slow and
    // answers "signed in as A", the state before the user signs out.
    server.usage["a@example.com"] = ok("b@example.com", 99);
    server.slowStatus = { delayMs: 5_000, answer: signedIn("a@example.com") };
    const slot = await mount();
    await click(slot, "Sign out");
    await click(slot, "Sign out");
    expect(slot.getByText("Not signed in")).toBeTruthy();
    await advance(5_000);
    expect(slot.getByText("Not signed in")).toBeTruthy();
    expect(slot.queryByText(/Signed in as/u)).toBeNull();
    expect(slot.queryByText(/% used/u)).toBeNull();
  });

  it("a status read still in flight cannot undo a finished sign-in", async () => {
    server.usage["a@example.com"] = ok("b@example.com", 99);
    server.slowStatus = { delayMs: 5_000, answer: signedIn("a@example.com") };
    const slot = await mount();
    await signInAs(slot, "b@example.com", "Switch account");
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    await advance(5_000);
    expect(slot.getByText("Signed in as b@example.com")).toBeTruthy();
    expect(slot.getByText(/70% used/u)).toBeTruthy();
  });
});
