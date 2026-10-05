import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { FileSessionSource } from "@/lib/file-session";

const host = vi.hoisted(() => ({
  panels: {} as Record<string, ComponentType<PluginThreadPanelProps>>,
  values: { autoSave: "afterDelay" },
  contents: {} as Record<string, string>,
  writes: [] as Array<{ source: FileSessionSource; content: string; expectedSha256: string | null }>,
  settings: [] as Array<{ key: string; value: unknown }>,
}));

const sourceFor = (threadId: string): FileSessionSource => ({
  kind: "workspace", threadId, environmentId: `env_${threadId}`, projectId: "proj_test",
});
const rpc = {
  call: async (method: string, input: Record<string, unknown>) => {
    const source = (input.source ?? sourceFor(String(input.threadId))) as FileSessionSource;
    const id = source.environmentId!;
    const content = host.contents[id] ?? "";
    const sha256 = `sha:${content}`;
    if (method === "read") return { kind: "text", content, sha256, relativePath: "a.ts", absolutePath: `/${id}/a.ts` };
    if (method === "write") {
      host.writes.push(input as unknown as typeof host.writes[number]);
      if (input.expectedSha256 !== sha256) return { outcome: "conflict", currentSha256: sha256 };
      host.contents[id] = String(input.content);
      return { outcome: "written", sha256: `sha:${input.content}` };
    }
    if (method === "workspace") return { source, root: `/${id}`, label: String(input.threadId) };
    if (method === "workspaces") return {
      named: false, degraded: null, coordinatorThreadId: "coordinator",
      entries: ["A", "B"].map((threadId) => ({
        threadId, role: "thread", label: threadId, title: threadId, workerRef: null,
        bbProjectId: "proj_test", status: "idle", archived: false,
        environmentId: `env_${threadId}`, hostId: "host_test", branch: null,
        isWorktree: false, workspaceKind: "project-checkout", environmentName: null,
        environmentPath: `/${threadId}`, available: true, reason: null,
      })),
    };
    if (method === "tree") return { root: `/${id}`, entries: [] };
    if (method === "diffList") return {
      source, root: `/${id}`, label: String(input.threadId), baseBranch: null, truncated: false, message: null,
      files: [{ path: "a.ts", previousPath: null, changeKind: "modified", origin: "tracked", binary: false, loadMode: "auto", additions: 1, deletions: 1 }],
    };
    if (method === "diffRead") return {
      kind: "text", source, path: "a.ts", previousPath: null, changeKind: "modified", origin: "tracked",
      oldContent: "original", newContent: content, editable: true, reason: null, sha256,
      absolutePath: `/${id}/a.ts`, relativePath: "a.ts",
    };
    if (method === "setPanelTarget") return { persisted: true, reason: null };
    if (method === "setSetting") { host.settings.push(input as typeof host.settings[number]); return null; }
    throw new Error(`Unexpected RPC ${method}`);
  },
};

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  useSettings: () => ({ values: host.values }),
  useBbNavigate: () => () => {},
  experimental_Icon: () => null,
  experimental_useCodeTheme: () => ({ mode: "light", theme: null }),
  definePluginApp: (register: (app: unknown) => void) => {
    const ignore = () => {};
    register({ slots: {
      threadPanelAction: (slot: { id: string; component: ComponentType<PluginThreadPanelProps> }) => { host.panels[slot.id] = slot.component; },
      fileOpener: ignore, experimental_diffRenderer: ignore, commandPaletteAction: ignore, experimental_newThreadPanelAction: ignore,
    } });
  },
}));
vi.mock("@/lib/use-assets", () => ({ useAssets: () => ({ kind: "ready", baseUrl: "/assets" }) }));
vi.mock("@/lib/file-watch", () => ({ useFileWatch: () => {} }));
vi.mock("@/lib/client-log", () => ({ useEditorTelemetry: () => {}, bindClientLog: () => {}, reportCrash: vi.fn() }));
vi.mock("@/components/PierreSurface", async () => {
  const { useEffect, useImperativeHandle } = await import("react");
  return { default: function Surface(props: import("@/components/PierreSurface").PierreSurfaceProps) {
    useEffect(() => { props.onStatusChange?.({ kind: "ready" }); }, [props.onStatusChange]);
    useImperativeHandle(props.ref, () => ({ status: () => ({ kind: "ready" }), focus: () => true }) as import("@/components/PierreSurface").PierreSurfaceHandle);
    return <textarea aria-label="Editor buffer" value={props.content ?? ""} readOnly={props.readOnly}
      onFocus={props.onFocus} onBlur={props.onBlur} onChange={(event) => props.onChange?.(event.target.value, props.viewId)} />;
  } };
});

import "../app";
import { acquireFileSession, configureFileSessions, flushDirtySessions, memoryDraftStore, peekFileSession, resetFileSessions } from "@/lib/file-session";

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {};
  host.values = { autoSave: "afterDelay" };
  host.contents = { env_A: "alpha", env_B: "beta" };
  host.writes = [];
  host.settings = [];
  localStorage.clear();
  configureFileSessions({ autoSave: "off" });
});
afterEach(async () => {
  cleanup();
  resetFileSessions();
  await act(async () => {});
});

async function openPanel(action: "files" | "changes", manual = true) {
  const Panel = host.panels[action]!;
  render(<Panel threadId="coordinator" params={{ targetThreadId: "A", path: "a.ts" }} />);
  await screen.findByRole("textbox", { name: "Editor buffer" });
  fireEvent.click(screen.getByRole("button", { name: "Enable editing" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Editor buffer" }) as HTMLTextAreaElement).readOnly).toBe(false));
  if (!manual) return;
  fireEvent.click(screen.getByRole("button", { name: action === "files" ? "More actions" : "File actions" }));
  const toggle = screen.getByRole("menuitemcheckbox", { name: "Auto save" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() => expect(host.settings).toContainEqual({ key: "autoSave", value: "off" }));
}

async function editAndPick(next: "A" | "B") {
  const buffer = screen.getByRole("textbox", { name: "Editor buffer" });
  fireEvent.focus(buffer);
  fireEvent.change(buffer, { target: { value: "alpha draft" } });
  expect(peekFileSession(sourceFor("A"), "a.ts")!.getSnapshot().dirty).toBe(true);
  // Real pointer navigation blurs the editor before the menu's target click.
  fireEvent.blur(buffer);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "A", exact: true }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: next, exact: true }));
  await act(async () => {});
}

describe.each(["files", "changes"] as const)("%s manual workspace switch", (action) => {
  it.each(["onBlur", "afterDelay"])("still saves on blur and switches without a prompt in %s mode", async (autoSave) => {
    host.values = { autoSave };
    await openPanel(action, false);
    await editAndPick("B");
    expect(screen.getByRole("button", { name: "B", exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and switch" })).toBeNull();
    expect(host.writes).toEqual([{ source: sourceFor("A"), path: "a.ts", content: "alpha draft", expectedSha256: "sha:alpha" }]);
    expect(host.contents).toEqual({ env_A: "alpha draft", env_B: "beta" });
  });

  it("asks before saving after editor blur and Cancel keeps the original dirty workspace", async () => {
    await openPanel(action);
    await editAndPick("B");
    expect(host.writes).toEqual([]);
    expect(host.contents).toEqual({ env_A: "alpha", env_B: "beta" });
    expect(screen.getByRole("button", { name: "Save and switch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep unsaved and switch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "A", exact: true })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Editor buffer" }) as HTMLTextAreaElement).value).toBe("alpha draft");
    expect(host.writes).toEqual([]);
  });

  it("Save and switch writes only the outgoing source with its expected hash", async () => {
    await openPanel(action);
    // Another workspace already has unsaved work; A's blur must not save it.
    const writeSibling = vi.fn(async () => { throw new Error("B must not write"); });
    const sibling = acquireFileSession({ source: sourceFor("B"), path: "a.ts", io: {
      read: async () => ({ kind: "text", content: "beta", sha256: "sha:beta", absolutePath: "/env_B/a.ts", relativePath: "a.ts" }),
      write: writeSibling,
    }, drafts: memoryDraftStore() });
    const detach = sibling.attach("other-editor");
    await waitFor(() => expect(sibling.getSnapshot().load.kind).toBe("ready"));
    sibling.setContent("beta draft", "other-editor");
    await editAndPick("B");
    fireEvent.click(screen.getByRole("button", { name: "Save and switch" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "B", exact: true })).toBeTruthy());
    expect(host.writes).toEqual([{ source: sourceFor("A"), path: "a.ts", content: "alpha draft", expectedSha256: "sha:alpha" }]);
    expect(host.contents).toEqual({ env_A: "alpha draft", env_B: "beta" });
    expect(sibling.getSnapshot().content).toBe("beta draft");
    expect(sibling.getSnapshot().dirty).toBe(true);
    expect(writeSibling).not.toHaveBeenCalled();
    // Prevent teardown from saving this independently held test buffer.
    sibling.attach("other-inspector", { writable: false });
    detach();
  });
});

it("parks the Files draft and a return in inspection cannot flush or discard it", async () => {
  await openPanel("files");
  await editAndPick("B");
  fireEvent.click(screen.getByRole("button", { name: "Keep unsaved and switch" }));
  await screen.findByRole("button", { name: "B", exact: true });
  expect(host.writes).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "B", exact: true }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "A", exact: true }));
  const buffer = await screen.findByRole("textbox", { name: "Editor buffer" });
  expect((buffer as HTMLTextAreaElement).value).toBe("alpha draft");
  expect((buffer as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.blur(buffer);
  const session = peekFileSession(sourceFor("A"), "a.ts")!;
  await act(async () => {
    await session.save();
    await flushDirtySessions({ source: sourceFor("A") });
    await session.reload();
  });
  expect(session.getSnapshot().content).toBe("alpha draft");
  expect(session.getSnapshot().dirty).toBe(true);
  expect(host.writes).toEqual([]);
  expect(host.contents.env_A).toBe("alpha");
});
