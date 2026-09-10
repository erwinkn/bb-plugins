// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcError, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Share, type Status } from "../lib/model";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const app = await loadPluginApp(() => import("../app"));
const THREAD = "thr_share";
const DAY = 86_400_000;
const NOW = Date.now();
const slots: ReturnType<typeof renderSlot>[] = [];
const clipboard = vi.fn(async (_value: string) => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function share(overrides: Partial<Share> = {}): Share {
  return {
    id: "shr_1", threadId: THREAD, visibility: "access", url: "https://bb.example.com/s?k=secret",
    allowedEmails: [], includeTools: false, createdAt: NOW - 60_000,
    revokedAt: null, expiresAt: null, lastViewedAt: null, viewCount: 0, state: "active", ...overrides,
  };
}

function backend(shares: Share[] = [], status: Partial<Status> = {}) {
  const state = {
    shares,
    status: { configured: true, accessConfigured: true, publicLinksEnabled: true, defaultExpiryDays: 0, publicBaseUrl: "https://bb.example.com", missing: [], ...status } as Status,
  };
  const handlers: { -readonly [K in keyof typeof rpcContract]: NonNullable<PluginRpcTestHandlers<typeof rpcContract>[K]> } = {
    share_status: async () => structuredClone(state.status),
    share_list: async ({ threadId }) => ({ shares: structuredClone(state.shares.filter((item) => item.threadId === threadId)) }),
    share_create: async (input) => {
      const days = input.expiresInDays === undefined ? state.status.defaultExpiryDays : input.expiresInDays;
      const created = share({
        id: `shr_${state.shares.length + 1}`, threadId: input.threadId, visibility: input.visibility,
        createdAt: Date.now(), expiresAt: days ? Date.now() + days * DAY : null,
        allowedEmails: input.allowedEmails ?? [], includeTools: input.includeTools ?? false,
      });
      state.shares.push(created);
      return { share: structuredClone(created) };
    },
    share_update: async ({ threadId, shareId, ...patch }) => {
      const target = state.shares.find((item) => item.id === shareId && item.threadId === threadId)!;
      Object.assign(target, patch);
      return { share: structuredClone(target) };
    },
    share_revoke: async ({ shareId, threadId }) => {
      const target = state.shares.find((item) => item.id === shareId && item.threadId === threadId)!;
      Object.assign(target, { revokedAt: Date.now(), state: "revoked" });
      return { share: structuredClone(target) };
    },
  };
  return { state, handlers };
}

function mount(server = backend(), props: Partial<PluginThreadHeaderActionProps> = {}, connection: "connected" | "connecting" | "reconnecting" = "connected") {
  const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(app.threadHeaderActions[0]!,
    { threadId: THREAD, projectId: "proj", isCompactViewport: false, ...props },
    { rpc: server.handlers, realtimeConnectionState: connection });
  slots.push(slot);
  return slot;
}
const calls = (slot: ReturnType<typeof mount>, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
async function open(slot: ReturnType<typeof mount>) {
  fireEvent.click(within(slot.container).getByRole("button", { name: "Share" }));
  const dialog = await slot.findByRole("dialog", { name: "Share thread" });
  await waitFor(() => expect(within(dialog).queryByRole("status")).toBeNull());
  return within(dialog);
}
async function idle(slot: ReturnType<typeof mount>) {
  await waitFor(() => expect((slot.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  // Radix positioning uses ResizeObserver in a browser.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Share header and popover", () => {
  it("registers one header control with a wide label and an accessible icon-only compact button", async () => {
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "share", title: "Share" }]);
    const wide = mount(backend([share()]));
    await within(wide.container).findByRole("img", { name: "Active share links" });
    expect(within(wide.container).getByRole("button", { name: "Share" }).textContent).toBe("Share");
    const compact = mount(backend([share()]), { isCompactViewport: true });
    await within(compact.container).findByRole("img", { name: "Active share links" });
    expect(within(compact.container).getByRole("button", { name: "Share" }).textContent).toBe("");
    // jsdom has no layout engine; assert the compact content and accessible name.
    expect(within(compact.container).getByRole("button", { name: "Share" }).querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it("shows loading and an empty list without a dot", async () => {
    const server = backend();
    const pending = deferred<{ shares: Share[] }>();
    server.handlers.share_list = () => pending.promise;
    const slot = mount(server);
    fireEvent.click(slot.getByRole("button", { name: "Share" }));
    await slot.findByRole("status", { name: "Loading share links" });
    await act(async () => pending.resolve({ shares: [] }));
    await slot.findByText("No links yet");
    expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull();
  });

  it("renders only the missing configuration and settings path when unconfigured", async () => {
    const slot = mount(backend([share()], { configured: false, missing: ["publicBaseUrl", "accessAudience"] }));
    const dialog = await open(slot);
    expect(dialog.getByText("To enable sharing, set publicBaseUrl, accessAudience.")).toBeTruthy();
    expect(dialog.getByText("Settings → Share (/settings/plugins/share)")).toBeTruthy();
    expect(dialog.queryByRole("group", { name: "Link visibility" })).toBeNull();
    expect(dialog.queryByRole("list")).toBeNull();
    expect(dialog.queryByText(/Links open at/)).toBeNull();
  });

  it("requires a public confirmation, supports cancel, and refreshes after creation", async () => {
    const slot = mount(); const dialog = await open(slot);
    const before = calls(slot, "share_list").length;
    fireEvent.click(dialog.getByRole("button", { name: "Public" }));
    expect(calls(slot, "share_create")).toHaveLength(0);
    expect(dialog.getByText("Anyone with the link can read this thread.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(dialog.queryByRole("button", { name: "Create public link" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Public" }));
    fireEvent.click(dialog.getByRole("button", { name: "Create public link" }));
    await dialog.findByRole("listitem", { name: "Public link, active" });
    await idle(slot);
    expect(calls(slot, "share_create")[0]?.input).toEqual({ threadId: THREAD, visibility: "public", includeTools: false, expiresInDays: null });
    expect(calls(slot, "share_list").length).toBeGreaterThan(before);
    expect(dialog.queryByText("Anyone with the link can read this thread.")).toBeNull();
  });

  it("creates gated shares using the configured default expiry", async () => {
    const slot = mount(backend([], { defaultExpiryDays: 30 })); const dialog = await open(slot);
    expect((dialog.getByLabelText("New link expiry") as HTMLSelectElement).value).toBe("30");
    fireEvent.click(dialog.getByRole("button", { name: "Create link" }));
    await dialog.findByRole("listitem", { name: "Sign-in link, active" });
    expect(calls(slot, "share_create")[0]?.input).toMatchObject({ threadId: THREAD, visibility: "access", expiresInDays: 30, includeTools: false });
  });

  it("requires a separate keyboard activation to confirm a public link", async () => {
    const user = userEvent.setup();
    const slot = mount(); const dialog = await open(slot);
    dialog.getByRole("button", { name: "Public" }).focus();
    await user.keyboard("{Enter}");
    expect(calls(slot, "share_create")).toHaveLength(0);
    expect(dialog.getByText("Anyone with the link can read this thread.")).toBeTruthy();
    // Tab past the expiry select to the newly rendered confirmation button.
    await user.tab();
    expect(document.activeElement).toBe(dialog.getByLabelText("New link expiry"));
    await user.tab();
    expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Create public link" }));
    await user.keyboard("{Enter}");
    await idle(slot);
    expect(calls(slot, "share_create")).toHaveLength(1);
    expect(calls(slot, "share_create")[0]?.input).toMatchObject({ visibility: "public" });
  });

  it("keeps unavailable modes disabled with an accessible explanation", async () => {
    const slot = mount(backend([], { accessConfigured: false, publicLinksEnabled: false })); const dialog = await open(slot);
    for (const name of ["Sign-in required", "Public", "Create link"]) {
      const button = dialog.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true); fireEvent.click(button);
    }
    expect(dialog.getByText(/Set accessTeamDomain and accessAudience/)).toBeTruthy();
    expect(dialog.getByText(/Public links are disabled/)).toBeTruthy();
    expect(calls(slot, "share_create")).toHaveLength(0);
  });

  it("copies the URL with a toast, or exposes a selectable read-only URL on failure", async () => {
    const item = share(); const slot = mount(backend([item])); const dialog = await open(slot);
    fireEvent.click(dialog.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(item.url));
    expect(toasts.success).toHaveBeenCalledWith("Link copied");
    clipboard.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(dialog.getByRole("button", { name: "Copy" }));
    const input = await dialog.findByLabelText("Copy this link") as HTMLInputElement;
    expect(input.readOnly).toBe(true); expect(input.value).toBe(item.url);
    expect(input.selectionEnd).toBe(item.url.length);
  });

  it.each([false, true])("disables existing public links while keeping revoke available (compact: %s)", async (isCompactViewport) => {
    const server = backend([share({ visibility: "public" })], { publicLinksEnabled: false });
    const slot = mount(server, { isCompactViewport }); const dialog = await open(slot);
    const row = within(dialog.getByRole("listitem", { name: "Public link, disabled by settings" }));
    expect(row.getByText("Disabled by settings")).toBeTruthy();
    expect(row.queryByText("Active")).toBeNull();
    expect(row.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Revoke" }));
    fireEvent.click(row.getByRole("button", { name: "Revoke link" }));
    await dialog.findByText("Revoked");
    expect(calls(slot, "share_revoke")[0]?.input).toEqual({ threadId: THREAD, shareId: "shr_1" });
    expect(clipboard).not.toHaveBeenCalled();
  });

  it("keeps sign-in links active when public links are disabled", async () => {
    const slot = mount(backend([share()], { publicLinksEnabled: false })); const dialog = await open(slot);
    expect(dialog.getByText("Active")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(slot.getByRole("img", { name: "Active share links" })).toBeTruthy();
  });

  it("updates the public row, copy fallback, and header dot when settings are refreshed", async () => {
    const server = backend([share({ visibility: "public" })]);
    const slot = mount(server); let dialog = await open(slot);
    expect(slot.getByRole("img", { name: "Active share links" })).toBeTruthy();
    clipboard.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(dialog.getByRole("button", { name: "Copy" }));
    await dialog.findByLabelText("Copy this link");
    server.state.status.publicLinksEnabled = false;
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await dialog.findByText("Disabled by settings");
    expect(dialog.queryByLabelText("Copy this link")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull();
    server.state.status.publicLinksEnabled = true;
    fireEvent.click(dialog.getByRole("button", { name: "Close share popover" }));
    dialog = await open(slot);
    expect(dialog.getByText("Active")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(slot.getByRole("img", { name: "Active share links" })).toBeTruthy();
  });

  it("commits and removes validated chips, and rejects malformed entries without an RPC", async () => {
    const slot = mount(backend([share()])); const dialog = await open(slot);
    const input = dialog.getByLabelText("Allowed people");
    expect(input.getAttribute("placeholder")).toBe("Anyone who can sign in");
    fireEvent.change(input, { target: { value: "Person@Example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await dialog.findByRole("button", { name: "Remove person@example.com" }); await idle(slot);
    expect(calls(slot, "share_update")[0]?.input).toEqual({ threadId: THREAD, shareId: "shr_1", allowedEmails: ["person@example.com"] });
    fireEvent.change(input, { target: { value: "@Example.org" } });
    fireEvent.keyDown(input, { key: "," });
    await dialog.findByRole("button", { name: "Remove @example.org" }); await idle(slot);
    fireEvent.change(input, { target: { value: "bad@@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dialog.getByRole("alert").textContent).toContain("Invalid allow list entry");
    expect(calls(slot, "share_update")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Backspace" }); await idle(slot);
    await waitFor(() => expect(dialog.queryByRole("button", { name: "Remove @example.org" })).toBeNull());
    expect(calls(slot, "share_update")[2]?.input).toMatchObject({ allowedEmails: ["person@example.com"] });
  });

  it("commits commas inserted by mobile keyboards and validates a whole pasted list", async () => {
    const slot = mount(backend([share()])); const dialog = await open(slot);
    const input = dialog.getByLabelText("Allowed people");
    fireEvent.change(input, { target: { value: "a@example.com,@example.org," } });
    await dialog.findByRole("button", { name: "Remove @example.org" }); await idle(slot);
    expect(calls(slot, "share_update")[0]?.input).toMatchObject({ allowedEmails: ["a@example.com", "@example.org"] });
    fireEvent.change(input, { target: { value: "good@example.net,broken," } });
    expect(dialog.getByRole("alert")).toBeTruthy();
    expect(calls(slot, "share_update")).toHaveLength(1);
  });

  it("keeps the chip input focused and preserves the next entry typed during a save", async () => {
    const user = userEvent.setup();
    const server = backend([share()]);
    const pending = deferred<void>();
    const update = server.handlers.share_update;
    server.handlers.share_update = async (input) => { await pending.promise; return update(input); };
    const slot = mount(server); const dialog = await open(slot);
    const input = dialog.getByLabelText("Allowed people") as HTMLInputElement;
    input.focus();
    await user.keyboard("first@example.com{Enter}");
    expect(calls(slot, "share_update")).toHaveLength(1);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    await user.keyboard("second@example.com");
    await act(async () => pending.resolve());
    await idle(slot);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("second@example.com");
    await user.keyboard("{Enter}");
    await idle(slot);
    expect(document.activeElement).toBe(input);
    expect(calls(slot, "share_update")[1]?.input).toMatchObject({ allowedEmails: ["first@example.com", "second@example.com"] });
    expect(input.value).toBe("");
  });

  it.each([false, true])("preserves editable chip drafts after a failed save (edited while pending: %s)", async (edit) => {
    const user = userEvent.setup();
    const pending = deferred<{ share: Share }>();
    const server = backend([share()]);
    server.handlers.share_update = () => pending.promise;
    const slot = mount(server); const dialog = await open(slot);
    const input = dialog.getByLabelText("Allowed people") as HTMLInputElement;
    input.focus();
    await user.keyboard("first@example.com{Enter}");
    if (edit) await user.keyboard("second@example.com");
    await act(async () => pending.reject(new Error("Save failed")));
    await idle(slot);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(edit ? "second@example.com" : "first@example.com");
  });

  it("updates tool output and shows its warning", async () => {
    const slot = mount(backend([share()])); const dialog = await open(slot);
    const control = dialog.getByRole("switch", { name: "Include tool output" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(dialog.queryByText(/Tool output can contain/)).toBeNull();
    fireEvent.click(control);
    await dialog.findByText("Tool output can contain file contents, paths, and logs.");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(calls(slot, "share_update")[0]?.input).toEqual({ threadId: THREAD, shareId: "shr_1", includeTools: true });
  });

  it("updates expiry in milliseconds, accepts a custom date, and can remove expiry", async () => {
    const slot = mount(backend([share()])); const dialog = await open(slot);
    const before = Date.now();
    fireEvent.change(dialog.getByLabelText("Expiry"), { target: { value: "7" } }); await idle(slot);
    const first = calls(slot, "share_update")[0]?.input as { expiresAt: number };
    expect(first.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(first.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    fireEvent.change(dialog.getByLabelText("Expiry"), { target: { value: "custom" } });
    fireEvent.change(dialog.getByLabelText("Expiry date"), { target: { value: "2099-12-01T12:30" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save date" })); await idle(slot);
    await waitFor(() => expect(dialog.queryByLabelText("Expiry date")).toBeNull());
    expect(calls(slot, "share_update")[1]?.input).toMatchObject({ expiresAt: new Date("2099-12-01T12:30").getTime() });
    fireEvent.change(dialog.getByLabelText("Expiry"), { target: { value: "custom" } });
    fireEvent.change(dialog.getByLabelText("Expiry"), { target: { value: "current" } });
    expect(calls(slot, "share_update")).toHaveLength(2);
    expect(dialog.queryByLabelText("Expiry date")).toBeNull();
    fireEvent.change(dialog.getByLabelText("Expiry"), { target: { value: "never" } }); await idle(slot);
    expect(calls(slot, "share_update")[2]?.input).toMatchObject({ expiresAt: null });
  });

  it("requires revoke confirmation, then collapses the row and clears the dot", async () => {
    const slot = mount(backend([share()])); const dialog = await open(slot);
    fireEvent.click(dialog.getByRole("button", { name: "Revoke" }));
    expect(calls(slot, "share_revoke")).toHaveLength(0);
    fireEvent.click(dialog.getByRole("button", { name: "Revoke link" }));
    const row = await dialog.findByRole("listitem", { name: "Sign-in link, revoked" });
    expect(calls(slot, "share_revoke")[0]?.input).toEqual({ threadId: THREAD, shareId: "shr_1" });
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(slot.container).queryByRole("img", { name: "Active share links" })).toBeNull();
  });

  it("sorts active links first and newest first, with no controls on expired or revoked rows", async () => {
    const slot = mount(backend([
      share({ id: "old", createdAt: NOW - DAY }),
      share({ id: "revoked", visibility: "public", state: "revoked", createdAt: NOW, revokedAt: NOW }),
      share({ id: "new", visibility: "public", createdAt: NOW - 60_000, viewCount: 3, lastViewedAt: NOW - 120_000 }),
      share({ id: "expired", state: "expired", createdAt: NOW - 2 * DAY, expiresAt: NOW - DAY }),
    ])); const dialog = await open(slot);
    const rows = dialog.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Public link, active", "Sign-in link, active", "Public link, revoked", "Sign-in link, expired"]);
    expect(within(rows[0]!).queryByLabelText("Allowed people")).toBeNull();
    expect(rows[0]!.textContent).toContain("3 views · Last viewed 2m ago");
    for (const row of rows.slice(2)) {
      expect(within(row).queryByRole("button")).toBeNull();
      expect(within(row).queryByRole("switch")).toBeNull();
      expect(row.textContent).not.toContain("views");
    }
  });

  it("refreshes only for this thread's realtime signals, and reconciles after reconnect", async () => {
    const server = backend(); const slot = mount(server);
    await waitFor(() => expect(calls(slot, "share_list")).toHaveLength(1));
    await slot.behavior.emitRealtime("share:changed", { threadId: "other" });
    await slot.behavior.emitRealtime("share:changed", null);
    expect(calls(slot, "share_list")).toHaveLength(1);
    server.state.shares.push(share());
    await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    await slot.findByRole("img", { name: "Active share links" });
    expect(calls(slot, "share_list")).toHaveLength(2);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    server.state.shares = [];
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull());
    expect(calls(slot, "share_list")).toHaveLength(3);
  });

  it("reconciles if mounted during an outage, but does not double-load on first connection", async () => {
    const first = mount(backend(), {}, "connecting");
    await first.behavior.setRealtimeConnectionState("connected");
    expect(calls(first, "share_list")).toHaveLength(1);
    const outage = mount(backend(), {}, "reconnecting");
    await outage.behavior.setRealtimeConnectionState("connected");
    expect(calls(outage, "share_list")).toHaveLength(2);
  });

  it.each([false, true])("debounces realtime bursts and runs one trailing refresh (popover open: %s)", async (isOpen) => {
    const server = backend(); const slot = mount(server);
    await act(async () => {});
    if (isOpen) await open(slot);
    vi.useFakeTimers();
    const before = calls(slot, "share_list").length;
    const pending = deferred<{ shares: Share[] }>();
    server.handlers.share_list = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue({ shares: [share()] });
    const burst = async () => {
      for (let i = 0; i < 25; i++) await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    };
    await burst();
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(calls(slot, "share_list")).toHaveLength(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls(slot, "share_list")).toHaveLength(before + 1);
    await burst();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(calls(slot, "share_list")).toHaveLength(before + 1);
    await act(async () => pending.resolve({ shares: [] }));
    expect(calls(slot, "share_list")).toHaveLength(before + 2);
    expect(slot.getByRole("img", { name: "Active share links" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(calls(slot, "share_list")).toHaveLength(before + 2);
  });

  it("runs the queued refresh after a failed list request", async () => {
    vi.useFakeTimers();
    const server = backend();
    const pending = deferred<{ shares: Share[] }>();
    server.handlers.share_list = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue({ shares: [share()] });
    const slot = mount(server);
    for (let i = 0; i < 10; i++) await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    expect(calls(slot, "share_list")).toHaveLength(1);
    await act(async () => pending.reject(new Error("Temporary list failure")));
    expect(toasts.error).toHaveBeenCalledWith("Temporary list failure");
    expect(calls(slot, "share_list")).toHaveLength(2);
    expect(slot.getByRole("img", { name: "Active share links" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(calls(slot, "share_list")).toHaveLength(2);
  });

  it("keeps split panes isolated while coalescing list replies", async () => {
    const server = backend([share(), share({ id: "other", threadId: "other", state: "revoked" })]);
    const first = mount(server); const other = mount(server, { threadId: "other" });
    await within(first.container).findByRole("img", { name: "Active share links" });
    expect(within(other.container).queryByRole("img")).toBeNull();
    vi.useFakeTimers();
    const pending: ((result: { shares: Share[] }) => void)[] = [];
    server.handlers.share_list = () => new Promise((resolve) => pending.push(resolve));
    await first.behavior.emitRealtime("share:changed", { threadId: THREAD });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await first.behavior.emitRealtime("share:changed", { threadId: THREAD });
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]!({ shares: [share()] }));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!({ shares: [] }));
    expect(within(first.container).queryByRole("img")).toBeNull();
    expect(calls(other, "share_list")).toHaveLength(1);
  });

  it("shows structured RPC validation issues with field labels, entry numbers, and server reasons", async () => {
    const server = backend([share()]);
    server.handlers.share_update = async () => {
      throw Object.assign(new Error("rpc input validation failed"), {
        code: "invalid_input", message: "rpc input validation failed",
        issues: [
          { path: ["allowedEmails", 0], message: "not an email or @domain: foo" },
          { path: ["expiresAt"], message: "Must be in the supported range" },
          { message: "Update rejected" },
        ],
      } satisfies PluginRpcError);
    };
    const slot = mount(server); const dialog = await open(slot);
    fireEvent.change(dialog.getByLabelText("Allowed people"), { target: { value: "person@example.com" } });
    fireEvent.keyDown(dialog.getByLabelText("Allowed people"), { key: "Enter" });
    await idle(slot);
    expect(toasts.error).toHaveBeenCalledWith("Allowed people (entry 1): not an email or @domain: foo; Expiry: Must be in the supported range; Update rejected");
    expect(toasts.error).not.toHaveBeenCalledWith("rpc input validation failed");
  });

  it("ignores a pre-mutation list reply and refreshes once with the saved state", async () => {
    const server = backend([share()]);
    const slot = mount(server); const dialog = await open(slot);
    vi.useFakeTimers();
    const before = calls(slot, "share_list").length;
    const pending = deferred<{ shares: Share[] }>();
    const list = server.handlers.share_list;
    server.handlers.share_list = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(list);
    await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const control = dialog.getByRole("switch", { name: "Include tool output" });
    fireEvent.click(control);
    await act(async () => {});
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(calls(slot, "share_list")).toHaveLength(before + 1);
    await act(async () => pending.resolve({ shares: [share()] }));
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(calls(slot, "share_list")).toHaveLength(before + 2);
    expect((dialog.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows server mutation errors, refreshes, and prevents duplicate clicks while saving", async () => {
    const server = backend([share()]);
    let reject!: (error: Error) => void;
    server.handlers.share_update = () => new Promise((_resolve, fail) => { reject = fail; });
    const slot = mount(server); const dialog = await open(slot);
    const before = calls(slot, "share_list").length;
    const control = dialog.getByRole("switch", { name: "Include tool output" });
    fireEvent.click(control); fireEvent.click(control);
    expect(calls(slot, "share_update")).toHaveLength(1);
    await act(async () => reject(new Error("This share has been revoked.")));
    expect(toasts.error).toHaveBeenCalledWith("This share has been revoked.");
    expect(calls(slot, "share_list").length).toBeGreaterThan(before);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("discards drafts and pending replies when the host reuses a header for a different thread", async () => {
    const server = backend([share()]); const slot = mount(server); const dialog = await open(slot);
    fireEvent.change(dialog.getByLabelText("Allowed people"), { target: { value: "unsent@example.com" } });
    let release!: (result: { shares: Share[] }) => void;
    server.handlers.share_list = ({ threadId }) => threadId === THREAD
      ? new Promise((resolve) => { release = resolve; }) : { shares: [] };
    await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    const Header = app.threadHeaderActions[0]!.component;
    slot.lifecycle.rerender(<Header threadId="other" projectId="proj" isCompactViewport={false} />);
    await act(async () => release({ shares: [share()] }));
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull();
    const next = await open(slot);
    expect(next.getByText("No links yet")).toBeTruthy();
    expect(next.queryByDisplayValue("unsent@example.com")).toBeNull();
    expect(calls(slot, "share_list").at(-1)?.input).toEqual({ threadId: "other" });
  });

  it("cancels a pending realtime debounce when a header unmounts", async () => {
    const slot = mount();
    await act(async () => {});
    vi.useFakeTimers();
    await slot.behavior.emitRealtime("share:changed", { threadId: THREAD });
    slot.lifecycle.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(calls(slot, "share_list")).toHaveLength(1);
  });

  it("clears the active dot at expiry even without a realtime event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 5000;
    const server = backend([share({ expiresAt })]);
    server.handlers.share_list = async () => ({ shares: [share({ expiresAt, state: Date.now() >= expiresAt ? "expired" : "active" })] });
    const slot = mount(server);
    await slot.findByRole("img", { name: "Active share links" });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(slot.queryByRole("img", { name: "Active share links" })).toBeNull();
    expect(calls(slot, "share_list")).toHaveLength(2);
  });

  it("shows load failures and recovers on retry", async () => {
    const server = backend();
    const list = server.handlers.share_list;
    server.handlers.share_list = async () => { throw new Error("Server unavailable"); };
    const slot = mount(server); const dialog = await open(slot);
    expect(dialog.getByRole("alert").textContent).toBe("Server unavailable");
    expect(toasts.error).toHaveBeenCalledWith("Server unavailable");
    server.handlers.share_list = list;
    fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    await dialog.findByText("No links yet");
  });

  it("portals the popover, moves focus inside, and closes with Escape", async () => {
    const slot = mount(); await open(slot);
    const dialog = slot.getByRole("dialog", { name: "Share thread" });
    expect(slot.container.contains(dialog)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "Share" }));
  });
});
