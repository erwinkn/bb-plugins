import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { DEFAULT_SNOOZE_PRESETS } from "../lib/snooze-presets";

type Host = ReturnType<typeof createFakePluginHost>;
const HOUR = 3_600_000;

// Threads the fake SDK knows; `pinnedAt` drives the wasPinned bookkeeping.
function host(pinned: Record<string, boolean> = {}) {
  return createFakePluginHost({
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "missing") throw new Error("Thread not found");
          return makeThreadResponse({
            id: threadId,
            pinnedAt: pinned[threadId] ? 1 : null,
          });
        },
        pin: async () => ({}),
        unpin: async () => ({}),
        markUnread: async () => ({}),
        updatePluginMetadata: async () => ({}),
      },
    },
  });
}
const calls = (h: Host, method: string) =>
  h.harness.inspection.sdk
    .callsTo(method)
    .map(([args]) => args as Record<string, unknown>);
const signals = (h: Host, channel: string) =>
  h.harness.inspection.realtimeSignals.filter(
    (signal) => signal.channel === channel,
  );

describe("snooze RPC", () => {
  it("registers a one-minute schedule and starts empty", async () => {
    const h = host();
    plugin(h.bb);
    try {
      expect(h.harness.registrations.schedules).toEqual([
        expect.objectContaining({ name: "snooze-wake", cron: "* * * * *" }),
      ]);
      await expect(h.harness.behavior.callRpc("getSnoozes", null)).resolves.toEqual({
        revision: 0,
        entries: [],
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("snoozes, replaces an existing entry, publishes, and mirrors metadata", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const now = Date.now();
      const first = await behavior.callRpc("snooze", { threadId: "a", until: now + HOUR });
      expect(first).toMatchObject({
        revision: 1,
        entries: [{ threadId: "a", until: now + HOUR, wokeAt: null, wasPinned: false }],
      });
      expect(signals(h, "snoozes-changed")).toEqual([
        { channel: "snoozes-changed", payload: first },
      ]);
      expect(calls(h, "threads.updatePluginMetadata")).toEqual([
        expect.objectContaining({
          threadId: "a",
          set: { snoozed: true, snoozedUntil: now + HOUR },
        }),
      ]);
      // A second snooze of the same thread replaces the wake time.
      const second = await behavior.callRpc("snooze", { threadId: "a", until: now + 2 * HOUR });
      expect(second).toMatchObject({
        revision: 2,
        entries: [{ threadId: "a", until: now + 2 * HOUR }],
      });
      await expect(
        behavior.callRpc("snooze", { threadId: "a", until: now - 1 }),
      ).rejects.toThrow(/future/);
      await expect(
        behavior.callRpc("snooze", { threadId: "missing", until: now + HOUR }),
      ).rejects.toThrow(/not found/);
      await expect(behavior.callRpc("snooze", { threadId: "", until: now + HOUR })).rejects.toThrow();
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("unsnoozes and clears the flag; unknown ids stay silent", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const now = Date.now();
      await behavior.callRpc("snooze", { threadId: "a", until: now + HOUR });
      await behavior.callRpc("snooze", { threadId: "b", until: now + HOUR });
      const next = await behavior.callRpc("unsnooze", { threadId: "a" });
      expect(next).toMatchObject({ entries: [{ threadId: "b" }] });
      expect(calls(h, "threads.updatePluginMetadata").at(-1)).toEqual(
        expect.objectContaining({ threadId: "a", remove: ["snoozed", "snoozedUntil"] }),
      );
      h.harness.inspection.realtimeSignals.length = 0;
      await behavior.callRpc("unsnooze", { threadId: "nope" });
      expect(signals(h, "snoozes-changed")).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("snooze wake schedule", () => {
  it("wakes only due entries, marks them unread, flags them woke, and catches up after a restart", async () => {
    const h = host();
    const now = Date.now();
    // Entries written by an earlier process: one past due, one still sleeping.
    await h.bb.storage.kv.set("snoozes", {
      revision: 4,
      entries: [
        { threadId: "due", until: now - HOUR, createdAt: now - 2 * HOUR, wokeAt: null, wasPinned: false },
        { threadId: "later", until: now + HOUR, createdAt: now, wokeAt: null, wasPinned: false },
      ],
    });
    plugin(h.bb);
    try {
      // The load-time catch-up runs before the first tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const doc = (await h.harness.behavior.callRpc("getSnoozes", null)) as {
        entries: { threadId: string; wokeAt: number | null }[];
      };
      expect(doc.entries.find((entry) => entry.threadId === "due")?.wokeAt).toEqual(
        expect.any(Number),
      );
      expect(doc.entries.find((entry) => entry.threadId === "later")?.wokeAt).toBeNull();
      expect(calls(h, "threads.markUnread")).toEqual([{ threadId: "due" }]);
      expect(calls(h, "threads.updatePluginMetadata")).toEqual([
        expect.objectContaining({ threadId: "due", remove: ["snoozed", "snoozedUntil"] }),
      ]);
      // A tick with nothing due changes nothing and publishes nothing.
      h.harness.inspection.realtimeSignals.length = 0;
      await h.harness.behavior.runSchedule("snooze-wake");
      expect(signals(h, "snoozes-changed")).toEqual([]);
      expect(calls(h, "threads.markUnread")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("acknowledge drops a woke entry but leaves a sleeping one", async () => {
    const h = host();
    const now = Date.now();
    await h.bb.storage.kv.set("snoozes", {
      revision: 1,
      entries: [
        { threadId: "woke", until: now - 1, createdAt: now - HOUR, wokeAt: now, wasPinned: false },
        { threadId: "sleeping", until: now + HOUR, createdAt: now, wokeAt: null, wasPinned: false },
      ],
    });
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      await expect(behavior.callRpc("acknowledge", { threadId: "sleeping" })).resolves.toMatchObject({
        revision: 1,
      });
      await expect(behavior.callRpc("acknowledge", { threadId: "woke" })).resolves.toMatchObject({
        revision: 2,
        entries: [{ threadId: "sleeping" }],
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("pinned threads", () => {
  it("unpins on snooze and pins again on unsnooze or wake", async () => {
    // The host's pin state changes under the plugin: pinned at first, then
    // unpinned once the snooze took it out of Pinned.
    let pinnedAt: number | null = 1;
    const h = createFakePluginHost({
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, pinnedAt }),
          pin: async () => ({}),
          unpin: async () => {
            pinnedAt = null;
            return {};
          },
          markUnread: async () => ({}),
          updatePluginMetadata: async () => ({}),
        },
      },
    });
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const now = Date.now();
      const doc = await behavior.callRpc("snooze", { threadId: "pinned", until: now + HOUR });
      expect(doc).toMatchObject({ entries: [{ threadId: "pinned", wasPinned: true }] });
      expect(calls(h, "threads.unpin")).toEqual([{ threadId: "pinned" }]);
      // Re-snoozing while asleep keeps the remembered pin even though the
      // host now reports the thread unpinned.
      const again = await behavior.callRpc("snooze", { threadId: "pinned", until: now + 2 * HOUR });
      expect(again).toMatchObject({ entries: [{ wasPinned: true, until: now + 2 * HOUR }] });
      expect(calls(h, "threads.unpin")).toHaveLength(1);
      await behavior.callRpc("unsnooze", { threadId: "pinned" });
      expect(calls(h, "threads.pin")).toEqual([{ threadId: "pinned" }]);
      // Waking restores the pin as well, next to the unread mark.
      await h.bb.storage.kv.set("snoozes", {
        revision: 9,
        entries: [
          { threadId: "pinned", until: now - 1, createdAt: now - HOUR, wokeAt: null, wasPinned: true },
        ],
      });
      await behavior.runSchedule("snooze-wake");
      expect(calls(h, "threads.pin")).toEqual([{ threadId: "pinned" }, { threadId: "pinned" }]);
      expect(calls(h, "threads.markUnread")).toEqual([{ threadId: "pinned" }]);
      // A woke entry already restored its pin; unsnoozing it pins nothing.
      await behavior.callRpc("unsnooze", { threadId: "pinned" });
      expect(calls(h, "threads.pin")).toHaveLength(2);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("keeps the document authoritative when host calls fail", async () => {
    const h = createFakePluginHost({
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, pinnedAt: 1 }),
          unpin: async () => {
            throw new Error("unpin failed");
          },
          updatePluginMetadata: async () => {
            throw new Error("metadata failed");
          },
        },
      },
    });
    plugin(h.bb);
    try {
      await expect(
        h.harness.behavior.callRpc("snooze", { threadId: "a", until: Date.now() + HOUR }),
      ).resolves.toMatchObject({ entries: [{ threadId: "a", wasPinned: true }] });
      const warnings = h.harness.logEntries.filter((entry) => entry.level === "warn");
      expect(warnings.some((entry) => /unpin failed/.test(entry.message))).toBe(true);
      expect(warnings.some((entry) => /metadata failed/.test(entry.message))).toBe(true);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("agent activity and thread lifecycle", () => {
  const thread = (id: string) => makeThreadResponse({ id });

  it("ends a sleeping snooze on activity without marking unread, and ignores woke or unknown threads", async () => {
    const h = host({ pinned: true });
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const now = Date.now();
      await behavior.callRpc("snooze", { threadId: "pinned", until: now + HOUR });
      await behavior.callRpc("snooze", { threadId: "quiet", until: now + HOUR });
      await h.harness.emitThreadEvent("thread.active", { thread: thread("pinned") });
      const doc = (await behavior.callRpc("getSnoozes", null)) as {
        entries: { threadId: string; wokeAt: number | null }[];
      };
      expect(doc.entries.find((entry) => entry.threadId === "pinned")?.wokeAt).toEqual(
        expect.any(Number),
      );
      expect(doc.entries.find((entry) => entry.threadId === "quiet")?.wokeAt).toBeNull();
      expect(calls(h, "threads.markUnread")).toEqual([]);
      expect(calls(h, "threads.pin")).toEqual([{ threadId: "pinned" }]);
      // Further activity on the woke thread and events for strangers are no-ops.
      h.harness.inspection.realtimeSignals.length = 0;
      await h.harness.emitThreadEvent("thread.idle", {
        thread: thread("pinned"),
        lastAssistantText: null,
      });
      await h.harness.emitThreadEvent("thread.failed", { thread: thread("other"), error: null });
      expect(signals(h, "snoozes-changed")).toEqual([]);
      // Each activity event kind ends a sleep.
      await h.harness.emitThreadEvent("interaction.pending", {
        thread: thread("quiet"),
        interaction: {} as never,
      });
      const after = (await behavior.callRpc("getSnoozes", null)) as {
        entries: { threadId: string; wokeAt: number | null }[];
      };
      expect(after.entries.find((entry) => entry.threadId === "quiet")?.wokeAt).toEqual(
        expect.any(Number),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("drops archived and deleted threads; only the archive clears metadata", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const now = Date.now();
      await behavior.callRpc("snooze", { threadId: "archived", until: now + HOUR });
      await behavior.callRpc("snooze", { threadId: "deleted", until: now + HOUR });
      await behavior.callRpc("snooze", { threadId: "kept", until: now + HOUR });
      h.harness.inspection.sdk.calls.length = 0;
      await h.harness.emitThreadEvent("thread.archived", { thread: thread("archived") });
      await h.harness.emitThreadEvent("thread.deleted", { thread: thread("deleted") });
      await expect(behavior.callRpc("getSnoozes", null)).resolves.toMatchObject({
        entries: [{ threadId: "kept" }],
      });
      expect(calls(h, "threads.updatePluginMetadata")).toEqual([
        expect.objectContaining({ threadId: "archived", remove: ["snoozed", "snoozedUntil"] }),
      ]);
      expect(calls(h, "threads.pin")).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("snooze presets document", () => {
  it("serves the defaults, saves a validated list, and rejects bad input before writing", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      await expect(behavior.callRpc("getSnoozePresets", null)).resolves.toEqual({
        revision: 0,
        presets: DEFAULT_SNOOZE_PRESETS,
      });
      const custom = [
        { id: "later", label: "Later", rule: { type: "duration", minutes: 15 } },
      ];
      const saved = await behavior.callRpc("saveSnoozePresets", { presets: custom });
      expect(saved).toEqual({ revision: 1, presets: custom });
      expect(signals(h, "snooze-presets-changed")).toEqual([
        { channel: "snooze-presets-changed", payload: saved },
      ]);
      await expect(
        behavior.callRpc("saveSnoozePresets", {
          presets: [{ id: "Bad!", label: "x", rule: { type: "duration", minutes: 1 } }],
        }),
      ).rejects.toThrow(/CLI name/);
      await expect(behavior.callRpc("getSnoozePresets", null)).resolves.toEqual(saved);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("bb sidebar CLI", () => {
  it("snoozes with a preset, a duration, or an ISO time, defaulting to the invoking thread", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const result = await behavior.runCli(["snooze", "a", "--until", "tomorrow"]);
      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stdout).toMatch(/^Snoozed a until \d{4}-/);
      const doc = (await behavior.callRpc("getSnoozes", null)) as {
        entries: { threadId: string; until: number }[];
      };
      expect(new Date(doc.entries[0]!.until).getHours()).toBe(9);
      expect(await behavior.runCli(["snooze", "--until=2h"], { threadId: "ctx" })).toMatchObject({
        exitCode: 0,
        stdout: expect.stringMatching(/^Snoozed ctx until/),
      });
      const iso = new Date(Date.now() + HOUR).toISOString();
      expect(await behavior.runCli(["snooze", "b", "--until", iso])).toMatchObject({
        exitCode: 0,
        stdout: `Snoozed b until ${iso}.\n`,
      });
      const list = await behavior.runCli(["snoozes"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout.split("\n").filter(Boolean)).toHaveLength(3);
      const json = await behavior.runCli(["snoozes", "--json"]);
      expect(JSON.parse(json.stdout)).toEqual(
        expect.arrayContaining([expect.objectContaining({ threadId: "b", state: "sleeping" })]),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("unsnoozes, lists presets, and reports usage errors with exit code 2", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      await behavior.runCli(["snooze", "a", "--until", "1h"]);
      expect(await behavior.runCli(["unsnooze", "a"])).toMatchObject({
        exitCode: 0,
        stdout: "Unsnoozed a.\n",
      });
      expect(await behavior.runCli(["unsnooze", "a"])).toMatchObject({
        exitCode: 0,
        stdout: "a was not snoozed.\n",
      });
      const presets = await behavior.runCli(["presets"]);
      expect(presets.stdout).toMatch(/^1h\t1 hour\tin 1 hour\n/);
      expect(presets.stdout).toMatch(/next-week\tNext week\tnext week, same weekday, at 09:00/);
      expect(await behavior.runCli(["snooze", "a"])).toMatchObject({
        exitCode: 2,
        stderr: expect.stringMatching(/needs --until/),
      });
      expect(await behavior.runCli(["snooze", "a", "--until", "soon"])).toMatchObject({
        exitCode: 2,
        stderr: expect.stringMatching(/Cannot read "soon"/),
      });
      expect(await behavior.runCli(["snooze", "--until", "1h"])).toMatchObject({
        exitCode: 2,
        stderr: expect.stringMatching(/Pass a thread id/),
      });
      expect(await behavior.runCli(["snooze", "missing", "--until", "1h"])).toMatchObject({
        exitCode: 1,
        stderr: "Thread not found\n",
      });
      expect(await behavior.runCli(["nope"])).toMatchObject({ exitCode: 2 });
      expect(await behavior.runCli([])).toMatchObject({ exitCode: 2 });
      // Custom presets drive the CLI names.
      await behavior.callRpc("saveSnoozePresets", {
        presets: [{ id: "later", label: "Later", rule: { type: "duration", minutes: 15 } }],
      });
      expect(await behavior.runCli(["snooze", "a", "--until", "tomorrow"])).toMatchObject({
        exitCode: 2,
        stderr: expect.stringMatching(/preset \(later\)/),
      });
      expect(await behavior.runCli(["snooze", "a", "--until", "later"])).toMatchObject({ exitCode: 0 });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("still exports and imports spaces", async () => {
    const h = host();
    plugin(h.bb);
    try {
      const { behavior } = h.harness;
      const exported = await behavior.runCli(["spaces-export"]);
      expect(JSON.parse(exported.stdout)).toEqual({ revision: 0, spaces: [] });
      expect(await behavior.runCli(["spaces-import", "{not json"])).toMatchObject({ exitCode: 2 });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});
