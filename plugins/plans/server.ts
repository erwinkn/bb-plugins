import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { plansContract } from "./contract";
import { createPlanService, type WaitResult } from "./service";

/** `bb thread wait` uses the same default; long enough for a human review pass. */
const DEFAULT_WAIT_SECONDS = 20 * 60;
const MAX_WAIT_SECONDS = 24 * 60 * 60;

interface Flags {
  positional: string[];
  wait: boolean;
  timeoutMs: number;
  version?: string;
  thread?: string;
  note: string;
  comments: Array<{ quote: string; body: string; kind: "comment" | "redline" | "looksGood" }>;
}

/** Tiny argv parser: `--flag`, `--key value`, and repeatable annotation flags. */
function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], wait: false, timeoutMs: DEFAULT_WAIT_SECONDS * 1000, note: "", comments: [] };
  const take = (index: number, name: string) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--wait") flags.wait = true;
    else if (arg === "--timeout") {
      const seconds = z.coerce.number().int().min(1).max(MAX_WAIT_SECONDS).parse(take(i, arg));
      flags.timeoutMs = seconds * 1000;
      i += 1;
    } else if (arg === "--version-id") { flags.version = take(i, arg); i += 1; }
    else if (arg === "--thread") { flags.thread = take(i, arg); i += 1; }
    else if (arg === "--note") { flags.note = take(i, arg); i += 1; }
    else if (arg === "--comment") {
      const raw = take(i, arg);
      const split = raw.indexOf("::");
      if (split <= 0) throw new Error("--comment expects <quote>::<body>.");
      flags.comments.push({ quote: raw.slice(0, split), body: raw.slice(split + 2), kind: "comment" });
      i += 1;
    } else if (arg === "--redline") { flags.comments.push({ quote: take(i, arg), body: "", kind: "redline" }); i += 1; }
    else if (arg === "--looks-good") { flags.comments.push({ quote: take(i, arg), body: "", kind: "looksGood" }); i += 1; }
    else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
    else flags.positional.push(arg);
  }
  return flags;
}

export function waitInstruction(planId: string, versionId: string): string {
  return `Plan saved for review. Run \`bb plans wait ${planId} --version-id ${versionId}\` and act on its JSON result; run it in the background and await it if your shell tool has a time limit. Do not implement yet.`;
}

/** For providers whose tool calls cannot block: the prompt is held server-side. */
export function heldInstruction(planId: string, versionId: string): string {
  return `Plan ${planId} version ${versionId} is open for review and the thread is marked as waiting for the user. End your turn now without implementing. The decision arrives as a new message with the comments and note (never the plan text); do not poll or run \`bb plans wait\`.`;
}

/** The tool holds the thread for at most this long before returning `pending`. */
const TOOL_WAIT_MS = 24 * 60 * 60 * 1000;

export interface PluginOptions {
  /** Test hook: shorten the BB interaction lifetime per request. */
  interactionChunkMs?: number;
}

export default function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const settings = bb.settings.define({
    notifyThreadWhenUnattended: {
      type: "boolean",
      label: "Message the thread when no agent is waiting",
      description: "When a review lands while no `bb plans wait` call is attached, send a compact message to the linked thread so the agent still hears about it.",
      default: true,
    },
    nonBlockingProviders: {
      type: "string",
      label: "Providers whose tool calls cannot block",
      description: "Comma-separated provider IDs whose tool calls time out quickly (Cursor's MCP client stops after 60 seconds). For these, plans_submit keeps the review prompt pending on the thread without blocking, and the decision arrives as a thread message.",
      default: "acp-cursor",
    },
  });
  const isNonBlocking = async (threadId: string) => {
    const listed = (await settings.get()).nonBlockingProviders.split(",").map((item) => item.trim()).filter(Boolean);
    if (listed.length === 0) return false;
    const thread = await bb.sdk.threads.get({ threadId });
    return listed.includes(thread.providerId);
  };
  const service = createPlanService(bb, {
    notifyUnattended: async () => (await settings.get()).notifyThreadWhenUnattended,
    interactionChunkMs: options.interactionChunkMs,
  });
  const { delivery, wait, hold: _hold, version, ...rpcHandlers } = service;
  bb.rpc.register(plansContract, rpcHandlers);
  bb.agents.registerTool({
    name: "plans_submit",
    description: "Submit a Markdown plan to the Plans review panel, or submit a revised version, then block until the user sends feedback or approves. The result is the decision as JSON (status feedback|approved with comments and note). On providers whose tool calls cannot block, it returns status submitted while the review prompt stays pending on the thread; end the turn and the decision arrives as a message. This tool does not itself enforce provider plan mode.",
    presentation: { label: { pending: "Awaiting plan review", completed: "Plan reviewed" } },
    parameters: z.object({ title: z.string().min(1).max(200), markdown: z.string().min(1).max(100_000), planId: z.string().optional(), expectedVersionId: z.string().optional() }),
    async execute({ title, markdown, planId, expectedVersionId }, { threadId, signal }) {
      if (!threadId) throw new Error("Submit a plan from a BB thread.");
      let plan;
      if (planId) {
        if (!expectedVersionId) throw new Error("A revision needs expectedVersionId.");
        if (service.get({ id: planId }).threadId !== threadId) throw new Error("This plan belongs to another thread.");
        plan = service.revise({ id: planId, markdown, expectedVersionId });
      } else {
        plan = await service.create({ title, markdown, threadId });
      }
      const versionId = plan.versions.at(-1)!.id;
      if (await isNonBlocking(threadId)) {
        service.hold({ id: plan.id, versionId });
        return JSON.stringify({ status: "submitted", planId: plan.id, versionId, instruction: heldInstruction(plan.id, versionId) });
      }
      const result = await wait({ id: plan.id, versionId, timeoutMs: TOOL_WAIT_MS, signal, hold: true });
      return JSON.stringify(result);
    },
  });
  bb.cli.register({
    name: "plans",
    summary: "Submit plans for human review in the thread panel and wait for the decision.",
    commands: [
      { name: "submit", summary: "Submit a plan from a Markdown file in this thread; --wait blocks until it is reviewed", usage: "bb plans submit <file> [title] [plan-id expected-version-id] [--wait] [--timeout <seconds>]" },
      { name: "wait", summary: "Block until the reviewer sends feedback or approves; prints the decision as JSON, or status pending on timeout", usage: "bb plans wait <plan-id> [--version-id <id>] [--timeout <seconds>]" },
      { name: "get", summary: "Read a plan; --version-id returns one version's text and comments", usage: "bb plans get <plan-id> [--version-id <id>]" },
      { name: "list", summary: "List plans for this thread (or another with --thread), ten per page", usage: "bb plans list [offset] [--thread <thread-id>]" },
      { name: "review", summary: "Review another thread's plan (for example a child's) as its reviewer; a thread cannot review its own plan", usage: "bb plans review <plan-id> <version-id> approve|feedback [--note <text>] [--comment <quote>::<body>] [--redline <quote>] [--looks-good <quote>]" },
      { name: "delivery", summary: "Inspect a review receipt; resolve only after checking the linked thread", usage: "bb plans delivery <request-id> [sent|not-sent]" },
    ],
    async run(argv, ctx) {
      try {
        const flags = parseFlags(argv);
        const [command, ...args] = flags.positional;
        let result: unknown;
        const awaitDecision = (planId: string, versionId: string): Promise<WaitResult> =>
          wait({ id: planId, versionId, timeoutMs: flags.timeoutMs, signal: ctx.signal, hold: true });
        if (command === "list") result = service.list({ threadId: flags.thread ?? ctx.threadId, offset: z.coerce.number().int().nonnegative().parse(args[0] ?? 0) });
        else if (command === "get" && args[0]) result = flags.version ? version({ id: args[0], versionId: flags.version }) : service.get({ id: args[0] });
        else if (command === "wait" && args[0]) result = await awaitDecision(args[0], flags.version ?? service.get({ id: args[0] }).versions.at(-1)!.id);
        else if (command === "delivery" && args[0]) {
          const resolution = z.enum(["sent", "not-sent"]).optional().parse(args[1]);
          result = delivery(args[0], resolution);
        } else if (command === "review" && args[0] && args[1]) {
          const action = z.enum(["approve", "feedback"]).parse(args[2]);
          const plan = service.get({ id: args[0] });
          if (ctx.threadId && plan.threadId === ctx.threadId) throw new Error("A thread cannot review its own plan. The reviewer is the user or another thread.");
          for (const item of flags.comments) service.addComment({ id: plan.id, versionId: args[1], ...item });
          result = await service.submitReview({ id: plan.id, versionId: args[1], action, note: flags.note, requestId: randomUUID() });
          result = { planId: plan.id, versionId: args[1], action, status: (result as { status: string }).status };
        } else if (command === "submit" && args[0] && ctx.threadId) {
          const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
          if (!thread.environmentId) throw new Error("This thread has no environment.");
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          const { resolve } = await import("node:path");
          if (!ctx.cwd) throw new Error("The invoking workspace path is unavailable. Submit from a BB thread with a working directory.");
          const file = await bb.sdk.files.read({ path: resolve(ctx.cwd, args[0]), hostId: environment.hostId });
          if (file.contentEncoding !== "utf8") throw new Error("Use a UTF-8 Markdown file.");
          let plan;
          if (args[2]) {
            if (!args[3]) throw new Error("A revision needs the expected version ID.");
            if (service.get({ id: args[2] }).threadId !== ctx.threadId) throw new Error("This plan belongs to another thread.");
            plan = service.revise({ id: args[2], markdown: file.content, expectedVersionId: args[3] });
          } else plan = await service.create({ title: args[1] ?? "Plan", markdown: file.content, threadId: ctx.threadId });
          const versionId = plan.versions.at(-1)!.id;
          result = flags.wait
            ? await awaitDecision(plan.id, versionId)
            : { planId: plan.id, versionId, instruction: waitInstruction(plan.id, versionId) };
        } else throw new Error("Usage: bb plans submit <file> [title] [plan-id expected-version-id] [--wait] [--timeout <s>], wait <plan-id> [--version-id <id>] [--timeout <s>], get <id> [--version-id <id>], list, review <plan-id> <version-id> approve|feedback [...], or delivery <receipt> [sent|not-sent].");
        const stdout = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(stdout) > 900_000) throw new Error("This result is too large for the CLI. Open the plan in the Plans panel.");
        return { exitCode: 0, stdout };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
