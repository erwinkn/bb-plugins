import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  describeRule,
  parseUntil,
  type SnoozePreset,
} from "./snooze-presets";
import { isSleeping, isWoke, type SnoozeDoc } from "./snooze-schema";
import { SnoozeError, type SnoozeStore } from "./snooze-store";
import { runSpacesCli, type SpacesStore } from "./spaces-store";

const presetNames = (presets: readonly SnoozePreset[]) =>
  presets.map((preset) => preset.id).join(", ");
export const sidebarCliUsage = (presets: readonly SnoozePreset[]) =>
  [
    "Usage:",
    "  bb sidebar snooze [threadId] --until <iso|duration|preset>",
    "  bb sidebar unsnooze [threadId]",
    "  bb sidebar snoozes [--json]",
    "  bb sidebar presets",
    "  bb sidebar spaces-export",
    "  bb sidebar spaces-import '<json>'",
    `Presets: ${presetNames(presets)} (edit them in the Threads settings section).`,
    "Durations: 45m, 2h, 3d, 1w. The thread defaults to the invoking thread.",
    "",
  ].join("\n");

export interface ParsedSnoozeArgs {
  action: string | undefined;
  threadId: string | undefined;
  until: string | undefined;
  json: boolean;
}

/** `bb sidebar <action> [threadId] [--until <value>] [--json]`. */
export function parseSnoozeArgs(argv: readonly string[]): ParsedSnoozeArgs {
  const [action, ...rest] = argv;
  const positional: string[] = [];
  let until: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--until") {
      until = rest[index + 1];
      index += 1;
    } else if (arg.startsWith("--until=")) until = arg.slice("--until=".length);
    else if (arg.startsWith("--"))
      throw new SnoozeError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new SnoozeError("Pass at most one thread id.");
  return { action, threadId: positional[0], until, json };
}

const describe = (doc: SnoozeDoc, now: number) =>
  doc.entries.map((entry) => ({
    threadId: entry.threadId,
    until: new Date(entry.until).toISOString(),
    state: isSleeping(entry, now)
      ? "sleeping"
      : isWoke(entry)
        ? "woke"
        : "due",
    wasPinned: entry.wasPinned,
  }));

export function registerSidebarCli(
  bb: BbPluginApi,
  stores: { spaces: SpacesStore; snoozes: SnoozeStore },
) {
  bb.cli.register({
    name: "sidebar",
    summary:
      "Threads sidebar: snooze threads until later and manage shared spaces",
    commands: [
      {
        name: "snooze",
        summary:
          "Hide a thread until a time; it returns unread under Needs Attention",
        usage:
          "bb sidebar snooze [threadId] --until <iso|2h|3d|preset>  (presets: bb sidebar presets)",
      },
      {
        name: "unsnooze",
        summary: "End a snooze now and restore the thread's pin",
        usage: "bb sidebar unsnooze [threadId]",
      },
      {
        name: "snoozes",
        summary: "List snoozed threads with their wake times",
        usage: "bb sidebar snoozes [--json]",
      },
      {
        name: "presets",
        summary: "List the snooze preset names and what they resolve to",
        usage: "bb sidebar presets [--json]",
      },
      {
        name: "spaces-export",
        summary: "Print the space catalog as JSON",
        usage: "bb sidebar spaces-export",
      },
      {
        name: "spaces-import",
        summary: "Replace the space catalog with a JSON document",
        usage: "bb sidebar spaces-import '<json from spaces-export>'",
      },
    ],
    async run(
      argv: string[],
      ctx: PluginCliContext,
    ): Promise<PluginCliResult> {
      const action = argv[0];
      if (action === "spaces-export" || action === "spaces-import")
        return runSpacesCli(stores.spaces, argv);
      const { presets } = await stores.snoozes.readPresets();
      const usage = sidebarCliUsage(presets);
      try {
        const parsed = parseSnoozeArgs(argv);
        const now = Date.now();
        if (parsed.action === "presets") {
          if (parsed.json)
            return { exitCode: 0, stdout: `${JSON.stringify(presets, null, 2)}\n` };
          return {
            exitCode: 0,
            stdout: `${presets.map((preset) => `${preset.id}\t${preset.label}\t${describeRule(preset.rule)}`).join("\n")}\n`,
          };
        }
        if (parsed.action === "snoozes") {
          const doc = await stores.snoozes.read();
          const rows = describe(doc, now);
          if (parsed.json)
            return { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` };
          return {
            exitCode: 0,
            stdout: rows.length
              ? `${rows.map((row) => `${row.threadId}\t${row.state}\tuntil ${row.until}${row.wasPinned ? "\t(pinned)" : ""}`).join("\n")}\n`
              : "No snoozed threads.\n",
          };
        }
        if (parsed.action !== "snooze" && parsed.action !== "unsnooze")
          return { exitCode: 2, stderr: usage };
        const threadId = parsed.threadId ?? ctx.threadId;
        if (!threadId)
          throw new SnoozeError(
            "Pass a thread id, or run this from a BB thread.",
          );
        if (parsed.action === "unsnooze") {
          const before = await stores.snoozes.read();
          const had = before.entries.some((entry) => entry.threadId === threadId);
          await stores.snoozes.unsnooze(threadId, now);
          return {
            exitCode: 0,
            stdout: had
              ? `Unsnoozed ${threadId}.\n`
              : `${threadId} was not snoozed.\n`,
          };
        }
        if (parsed.until === undefined)
          throw new SnoozeError(
            `snooze needs --until <value>. Presets: ${presetNames(presets)}.`,
          );
        const until = parseUntil(parsed.until, now, presets);
        if (until === null)
          throw new SnoozeError(
            `Cannot read "${parsed.until}" as a future time. Use ISO 8601, a duration like 2h, or a preset (${presetNames(presets)}).`,
          );
        await stores.snoozes.snooze(threadId, until, now);
        return {
          exitCode: 0,
          stdout: `Snoozed ${threadId} until ${new Date(until).toISOString()}.\n`,
        };
      } catch (error) {
        if (error instanceof SnoozeError)
          return { exitCode: 2, stderr: `${error.message}\n${usage}` };
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
