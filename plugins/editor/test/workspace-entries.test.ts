import { describe, expect, it } from "vitest";
import {
  entryDisplayName,
  orderWorkspaceEntries,
  shapeWorkspaceEntry,
  type WorkspaceThreadRow,
} from "@/lib/workspace-entries";

function row(overrides: Partial<WorkspaceThreadRow> = {}): WorkspaceThreadRow {
  return {
    id: "thr_x",
    parentThreadId: "thr_coord",
    projectId: "proj_1",
    title: null,
    titleFallback: null,
    archivedAt: null,
    deletedAt: null,
    status: "active",
    environmentId: "env_1",
    environmentHostId: "host_1",
    environmentBranchName: "main",
    environmentIsWorktree: false,
    environmentName: "checkout",
    environmentPath: "/repo",
    environmentWorkspaceDisplayKind: "other",
    ...overrides,
  };
}

describe("shapeWorkspaceEntry", () => {
  it("names a Projects worker with its W ref and logical label", () => {
    const entry = shapeWorkspaceEntry(
      row({ id: "thr_w16", title: "W16 Finish cancellation evidence — cancelled op writes" }),
      { role: "worker", projectId: "proj_1", worker: 16 },
    );
    expect(entry).toMatchObject({
      threadId: "thr_w16",
      role: "worker",
      workerRef: "W16",
      label: "Finish cancellation evidence",
      available: true,
      reason: null,
    });
    expect(entryDisplayName(entry)).toBe("W16 · Finish cancellation evidence");
  });

  it("names the coordinator even without metadata", () => {
    const entry = shapeWorkspaceEntry(row({ id: "thr_coord", title: "bb-plugins · coordinator" }), null, {
      coordinator: true,
    });
    expect(entry.role).toBe("coordinator");
    expect(entryDisplayName(entry)).toBe("Coordinator");
  });

  it("falls back to native data when Projects is absent", () => {
    const entry = shapeWorkspaceEntry(row({ id: "thr_plain", title: "Scratch thread", titleFallback: "Scratch" }), null);
    expect(entry).toMatchObject({ role: "thread", workerRef: null, label: "Scratch thread" });
  });

  it("keeps the title's W ref when metadata is missing but the title names one", () => {
    const entry = shapeWorkspaceEntry(row({ id: "thr_w8", title: "W8 Handover — details" }), null);
    expect(entry.workerRef).toBe("W8");
    expect(entry.label).toBe("Handover");
    expect(entry.role).toBe("thread");
  });

  it("reads the shipped title shapes: ref-first and project-prefixed", () => {
    const refFirst = shapeWorkspaceEntry(row({ id: "thr_w22", title: "W22 · Editor scrolling" }), null);
    expect(refFirst).toMatchObject({ workerRef: "W22", label: "Editor scrolling" });
    const projectPrefix = shapeWorkspaceEntry(
      row({ id: "thr_w33", title: "bb-plugins · W33 Control Room feedback" }),
      { role: "worker", worker: 33 },
    );
    expect(projectPrefix).toMatchObject({ workerRef: "W33", label: "Control Room feedback" });
  });

  it("reports archived, deleted and workspace-less targets honestly", () => {
    expect(shapeWorkspaceEntry(row({ archivedAt: 1 }), null)).toMatchObject({ available: false, archived: true, reason: "This thread is archived" });
    expect(shapeWorkspaceEntry(row({ deletedAt: 2 }), null)).toMatchObject({ available: false, reason: "This thread was deleted" });
    expect(shapeWorkspaceEntry(row({ environmentId: null }), null)).toMatchObject({ available: false, reason: "This thread has no workspace" });
    expect(shapeWorkspaceEntry(row({ environmentPath: null }), null)).toMatchObject({
      available: false,
      reason: "This workspace has no filesystem path",
    });
  });
});

describe("orderWorkspaceEntries", () => {
  it("sorts coordinator, workers by number, then adhoc and unmanaged", () => {
    const entries = [
      shapeWorkspaceEntry(row({ id: "thr_plain", title: "B thread" }), null),
      shapeWorkspaceEntry(row({ id: "thr_w16", title: "W16 Bee" }), { role: "worker", worker: 16 }),
      shapeWorkspaceEntry(row({ id: "thr_coord" }), { role: "coordinator" }, { coordinator: true }),
      shapeWorkspaceEntry(row({ id: "thr_adhoc", title: "A adhoc" }), { role: "adhoc" }),
      shapeWorkspaceEntry(row({ id: "thr_w8", title: "W8 Ant" }), { role: "worker", worker: 8 }),
    ];
    expect(orderWorkspaceEntries(entries).map((entry) => entry.threadId)).toEqual([
      "thr_coord",
      "thr_w8",
      "thr_w16",
      "thr_adhoc",
      "thr_plain",
    ]);
  });
});
