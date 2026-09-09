import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { addAnnotationSchema, agentReplySchema, createSchema, idSchema, plansContract, updateSchema } from "./contract";
import { createPlanService, type PlanServiceOptions } from "./service";

interface Flags {
  positional: string[]; version?: string; thread?: string; summary?: string;
  resolves: string[]; noResolve: boolean; approve: boolean;
  annotations: Array<{ quote: string; body: string; kind: "comment" | "ask" | "redline" | "looksGood" }>;
}
function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], resolves: [], noResolve: false, approve: false, annotations: [] };
  const take = (index: number, name: string) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--version-id") flags.version = take(i++, arg);
    else if (arg === "--thread") flags.thread = take(i++, arg);
    else if (arg === "--summary") flags.summary = take(i++, arg);
    else if (arg === "--no-resolve") flags.noResolve = true;
    else if (arg === "--approve") flags.approve = true;
    else if (arg === "--resolve") {
      flags.resolves.push(take(i++, arg));
      while (argv[i + 1]?.startsWith("#")) flags.resolves.push(argv[++i]!);
    } else if (arg === "--comment" || arg === "--ask") {
      const raw = take(i++, arg); const split = raw.indexOf("::");
      if (split <= 0) throw new Error(`${arg} expects quote::body.`);
      flags.annotations.push({ quote: raw.slice(0, split), body: raw.slice(split + 2), kind: arg === "--ask" ? "ask" : "comment" });
    } else if (arg === "--redline" || arg === "--looks-good") {
      flags.annotations.push({ quote: take(i++, arg), body: "", kind: arg === "--redline" ? "redline" : "looksGood" });
    } else if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}.`);
    else flags.positional.push(arg);
  }
  return flags;
}

export type PluginOptions = PlanServiceOptions;
const toolBehavior = " Returns at once by design. After you finish the plan changes, call plans_handoff and end your turn. Feedback arrives as thread messages. Implement only after approval.";
export default function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const service = createPlanService(bb, options);
  bb.rpc.register(plansContract, service.rpc);
  const owns = (planId: string, threadId?: string | null) => {
    if (!threadId) throw new Error("Use this command from the plan's BB thread.");
    if (service.get({ id: planId }).threadId !== threadId) throw new Error("This plan belongs to another thread.");
  };
  bb.agents.registerTool({
    name: "plans_submit", description: "Create a Markdown plan and open its review prompt. This tool returns at once by design. End your turn after calling it. Feedback arrives as thread messages. Implement only after approval.",
    presentation: { label: { pending: "Submitting plan", completed: "Plan submitted" } },
    parameters: createSchema.pick({ title: true, markdown: true }),
    async execute(input, { threadId }) {
      if (!threadId) throw new Error("Submit a plan from a BB thread.");
      return JSON.stringify(await service.submit({ ...input, threadId }));
    },
  });
  bb.agents.registerTool({
    name: "plans_update", description: "Update the latest plan with exact-match edits or full Markdown and a summary. The resolves field sets each named annotation to addressed, including asks." + toolBehavior,
    presentation: { label: { pending: "Updating plan", completed: "Plan updated" } }, parameters: updateSchema,
    execute(input, { threadId }) { owns(input.planId, threadId); return JSON.stringify(service.update(input)); },
  });
  bb.agents.registerTool({
    name: "plans_reply", description: "Reply to an annotation by number or ID. An ask becomes answered by default. With resolve=false, keep its current state, including answered or addressed. For a comment or redline, keep the state by default; resolve=true sets addressed." + toolBehavior,
    presentation: { label: { pending: "Replying to annotation", completed: "Reply saved" } }, parameters: agentReplySchema,
    execute(input, { threadId }) { owns(input.planId, threadId); return JSON.stringify(service.reply(input)); },
  });
  bb.agents.registerTool({
    name: "plans_handoff", description: "Restore the plan review prompt. Create no prompt while a plugin message is still queued for the thread; that message already brings the agent back. This tool returns at once by design. End your turn after calling it. Feedback arrives as thread messages. Do not poll.",
    presentation: { label: { pending: "Opening plan review", completed: "Plan ready for review" } }, parameters: z.object({ planId: idSchema }),
    execute(input, { threadId }) { owns(input.planId, threadId); return JSON.stringify(service.handoff(input)); },
  });
  const readFile = async (file: string, ctx: PluginCliContext) => {
    if (!ctx.threadId || !ctx.cwd) throw new Error("Read a plan file from a BB thread with a working directory.");
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const result = await bb.sdk.files.read({ path: resolve(ctx.cwd, file), rootPath: environment.path ?? ctx.cwd, hostId: environment.hostId });
    if (result.contentEncoding !== "utf8") throw new Error("Use a UTF-8 Markdown file.");
    return result.content;
  };
  bb.cli.register({
    name: "plans", summary: "Submit and update live plans. Tools return at once; feedback arrives as thread messages.",
    commands: [
      { name: "submit", summary: "Submit a plan and end the turn", usage: "bb plans submit <file> [title]" },
      { name: "update", summary: "Update a plan from a file", usage: "bb plans update <plan> <file> --summary <text> [--resolve #n ...]" },
      { name: "reply", summary: "Reply to an annotation", usage: "bb plans reply <plan> <#n> <text> [--no-resolve]" },
      { name: "handoff", summary: "Open the review prompt and end the turn", usage: "bb plans handoff <plan>" },
      { name: "get", summary: "Read a plan or stored version", usage: "bb plans get <plan> [--version-id <id>]" },
      { name: "list", summary: "List ten plans for a thread", usage: "bb plans list [offset] [--thread <id>]" },
      { name: "review", summary: "Annotate or approve another thread's plan", usage: 'bb plans review <plan> [--comment "quote::body"] [--ask "quote::body"] [--redline "quote"] [--looks-good "quote"] [--approve]' },
    ],
    async run(argv, ctx) {
      try {
        const flags = parseFlags(argv); const [command, ...args] = flags.positional;
        let result: unknown;
        if (command === "list" && args.length <= 1) result = service.list({ threadId: flags.thread ?? ctx.threadId, offset: z.coerce.number().int().nonnegative().parse(args[0] ?? 0) });
        else if (command === "get" && args.length === 1) result = flags.version ? service.version({ id: args[0]!, versionId: flags.version }) : service.get({ id: args[0]! });
        else if (command === "submit" && args.length >= 1 && args.length <= 2 && ctx.threadId) {
          result = await service.submit({ title: args[1] ?? "Plan", markdown: await readFile(args[0]!, ctx), threadId: ctx.threadId });
        } else if (command === "update" && args.length === 2) {
          owns(args[0]!, ctx.threadId);
          if (!flags.summary) throw new Error("update needs --summary <text>.");
          result = service.update({ planId: args[0]!, markdown: await readFile(args[1]!, ctx), summary: flags.summary, resolves: flags.resolves });
        } else if (command === "reply" && args.length === 3) {
          owns(args[0]!, ctx.threadId);
          result = service.reply({ planId: args[0]!, annotation: args[1]!, body: args[2]!, resolve: flags.noResolve ? false : undefined });
        } else if (command === "handoff" && args.length === 1) {
          owns(args[0]!, ctx.threadId); result = service.handoff({ planId: args[0]! });
        } else if (command === "review" && args.length === 1) {
          if (!ctx.threadId) throw new Error("Review a plan from a reviewer thread.");
          const plan = service.get({ id: args[0]! });
          if (plan.threadId === ctx.threadId) throw new Error("A thread cannot review its own plan.");
          if (!flags.annotations.length && !flags.approve) throw new Error("Add an annotation or use --approve.");
          // Validate the whole batch before any annotations are saved.
          const inputs = flags.annotations.map((item) => addAnnotationSchema.parse({ id: plan.id, ...item }));
          for (const input of inputs) service.addAnnotation(input);
          result = flags.approve ? service.approve({ id: plan.id, requestId: randomUUID(), versionId: plan.versions.at(-1)!.id }) : service.get({ id: plan.id });
        } else throw new Error("Usage: bb plans submit <file> [title], update <plan> <file> --summary <text>, reply <plan> <#n> <text>, handoff <plan>, get <plan>, list [offset], or review <plan> [annotations] [--approve].");
        const stdout = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(stdout) > 900_000) throw new Error("This result is too large for the CLI. Open the plan in the Plans panel.");
        return { exitCode: 0, stdout };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
