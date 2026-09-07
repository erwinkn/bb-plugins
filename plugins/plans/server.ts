import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { plansContract } from "./contract";
import { createPlanService } from "./service";

export default function plugin(bb: BbPluginApi) {
  const service = createPlanService(bb);
  const { delivery, ...rpcHandlers } = service;
  bb.rpc.register(plansContract, rpcHandlers);
  bb.agents.registerTool({
    name: "plans_submit",
    description: "Submit a Markdown plan to the Plans review panel, or submit a revised version. After submitting, stop and wait for user review. This tool does not itself enforce provider plan mode.",
    parameters: z.object({ title: z.string().min(1).max(200), markdown: z.string().min(1).max(100_000), planId: z.string().optional(), expectedVersionId: z.string().optional() }),
    async execute({ title, markdown, planId, expectedVersionId }, { threadId }) {
      if (!threadId) throw new Error("Submit a plan from a BB thread.");
      let plan;
      if (planId) {
        if (!expectedVersionId) throw new Error("A revision needs expectedVersionId.");
        if (service.get({ id: planId }).threadId !== threadId) throw new Error("This plan belongs to another thread.");
        plan = service.revise({ id: planId, markdown, expectedVersionId });
      } else {
        plan = await service.create({ title, markdown, threadId });
      }
      return JSON.stringify({ planId: plan.id, versionId: plan.versions.at(-1)!.id, panel: { actionId: "review-plan", params: { threadId, planId: plan.id } }, instruction: "Plan saved for review. Stop now and wait for feedback or approval. Do not implement yet." });
    },
  });
  bb.cli.register({
    name: "plans",
    summary: "Submit and inspect plans for human review in the thread review panel.",
    commands: [
      { name: "submit", summary: "Submit a plan from a Markdown file in this thread", usage: "bb plans submit <file> [title] [plan-id] [expected-version-id]" },
      { name: "get", summary: "Read a plan and its comments", usage: "bb plans get <plan-id>" },
      { name: "list", summary: "List plans for this thread, ten per page", usage: "bb plans list [offset]" },
      { name: "delivery", summary: "Inspect a review receipt; resolve only after checking the linked thread", usage: "bb plans delivery <request-id> [sent|not-sent]" },
    ],
    async run(argv, ctx) {
      try {
        let result: unknown;
        if (argv[0] === "list") result = service.list({ threadId: ctx.threadId, offset: z.coerce.number().int().nonnegative().parse(argv[1] ?? 0) });
        else if (argv[0] === "get" && argv[1]) result = service.get({ id: argv[1] });
        else if (argv[0] === "delivery" && argv[1]) {
          const resolution = z.enum(["sent", "not-sent"]).optional().parse(argv[2]);
          result = delivery(argv[1], resolution);
        } else if (argv[0] === "submit" && argv[1] && ctx.threadId) {
          const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
          if (!thread.environmentId) throw new Error("This thread has no environment.");
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          const { resolve } = await import("node:path");
          if (!ctx.cwd) throw new Error("The invoking workspace path is unavailable. Submit from a BB thread with a working directory.");
          const file = await bb.sdk.files.read({ path: resolve(ctx.cwd, argv[1]), hostId: environment.hostId });
          if (file.contentEncoding !== "utf8") throw new Error("Use a UTF-8 Markdown file.");
          if (argv[3]) {
            if (!argv[4]) throw new Error("A revision needs the expected version ID.");
            if (service.get({ id: argv[3] }).threadId !== ctx.threadId) throw new Error("This plan belongs to another thread.");
            result = service.revise({ id: argv[3], markdown: file.content, expectedVersionId: argv[4] });
          } else result = await service.create({ title: argv[2] ?? "Plan", markdown: file.content, threadId: ctx.threadId });
          const plan = result as ReturnType<typeof service.get>;
          result = { planId: plan.id, versionId: plan.versions.at(-1)!.id, instruction: "Stop and wait for user review. Do not implement yet." };
        } else throw new Error("Usage: bb plans submit <file> [title] [plan-id] [expected-version-id], get <id>, list, or delivery <receipt> [sent|not-sent].");
        const stdout = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(stdout) > 900_000) throw new Error("This result is too large for the CLI. Open the plan in the Plans panel.");
        return { exitCode: 0, stdout };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
