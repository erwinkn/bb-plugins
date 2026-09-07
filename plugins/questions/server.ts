// Questions plugin backend: a durable, thread-bound collection of agent
// questions and user answers. Rounds are created by the agent tool or the
// CLI, drafts and submissions live in the plugin's SQLite database, and
// answers resolve BB's user input interaction, with messages for late submissions.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  LIMITS,
  REALTIME_CHANNEL,
  type ChangeSignal,
  answerSchema,
  answerStateSchema,
  roundSchema,
  submissionSchema,
  threadStateSchema,
  hasContent,
} from "./lib/model";
import { MIGRATIONS, QuestionsStore } from "./server/store";
import { QuestionsError, QuestionsService } from "./server/service";
import { QuestionInteractions } from "./server/interactions";

const threadArg = z.object({ threadId: z.string().min(1) });

const saveDraftOutput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), state: answerStateSchema }),
  z.object({ outcome: z.literal("conflict"), state: answerStateSchema }),
]);

export const rpcContract = defineRpcContract({
  questions_state: {
    input: threadArg,
    output: threadStateSchema,
  },
  questions_round: {
    input: threadArg.extend({ roundId: z.string().min(1) }),
    output: z.object({
      round: roundSchema.nullable(),
      answers: z.array(answerStateSchema),
      /** Thread-wide labels for the round's questions, keyed by question id. */
      labels: z.record(z.string(), z.string()),
    }),
  },
  questions_save_draft: {
    input: threadArg.extend({
      questionId: z.string().min(1),
      draft: answerSchema,
      expectedVersion: z.number().int().nonnegative(),
    }),
    output: saveDraftOutput,
  },
  questions_upload_attachment: {
    input: threadArg.extend({
      questionId: z.string().min(1),
      expectedVersion: z.number().int().nonnegative(),
      name: z.string().min(1).max(255),
      mimeType: z.string().max(200).nullable(),
      dataBase64: z.string().max(Math.ceil(LIMITS.attachmentBytes / 3) * 4),
    }),
    output: saveDraftOutput,
  },
  questions_attachment_preview: {
    input: threadArg.extend({ questionId: z.string().min(1), path: z.string().min(1) }),
    output: z.object({ dataUrl: z.string().nullable() }),
  },
  questions_search_paths: {
    input: threadArg.extend({ query: z.string().max(512) }),
    output: z.object({
      environmentId: z.string().nullable(),
      hostId: z.string().nullable(),
      hits: z.array(
        z.object({ path: z.string(), name: z.string(), kind: z.enum(["file", "directory"]) }),
      ),
      truncated: z.boolean(),
      unavailable: z.string().nullable(),
    }),
  },
  questions_submit: {
    input: threadArg.extend({
      submissionId: z.string().uuid(),
      items: z.array(
        z.object({ questionId: z.string().min(1), expectedVersion: z.number().int().nonnegative() }),
      ),
    }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("submitted"), submission: submissionSchema }),
      z.object({
        outcome: z.literal("conflict"),
        questionIds: z.array(z.string()),
        states: z.array(answerStateSchema),
      }),
      z.object({ outcome: z.literal("in-flight"), questionIds: z.array(z.string()) }),
      z.object({ outcome: z.literal("nothing") }),
    ]),
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const askToolSchema = z.object({
  mode: z
    .enum(["panel", "inline"])
    .default("panel")
    .describe(
      'Where the user answers. "panel": the persistent Questions side panel, any number of questions, with optional attachments, references, confidence, and citations of earlier answers. "inline": a short card inside the thread, at most 5 questions, choices and free text only.',
    ),
  intro: z
    .string()
    .max(LIMITS.introChars)
    .optional()
    .describe("One or two sentences shown above the round: what you need and why."),
  questions: z
    .array(
      z.object({
        title: z.string().min(1).max(LIMITS.titleChars).describe("The question, as a full sentence."),
        optional: z.boolean().optional().describe("Allow the user to skip this question. Questions are required by default."),
        help: z.string().max(LIMITS.helpChars).optional().describe("Optional context under the title."),
        options: z
          .array(z.string().min(1).max(LIMITS.optionChars))
          .max(LIMITS.optionsPerQuestion)
          .optional()
          .describe("Choices. Omit for a free-text question. The user can always type their own answer."),
        select: z
          .enum(["single", "multiple"])
          .optional()
          .describe('How many options may be chosen; defaults to "single".'),
        cites: z
          .array(z.string())
          .max(10)
          .optional()
          .describe('Side panel only: labels of earlier questions ("Q3") whose submitted answers this question builds on.'),
        attachments: z.boolean().optional().describe("Side panel only: let the user attach files or images."),
        references: z.boolean().optional().describe("Side panel only: let the user pick workspace files."),
        confidence: z.boolean().optional().describe("Side panel only: ask for a low, medium, or high confidence."),
      }),
    )
    .min(1),
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new QuestionsStore(db);
  const interactions = new QuestionInteractions(bb);
  const asking = new Set<string>();
  function claimAsk(threadId: string): () => void {
    if (asking.has(threadId)) throw new QuestionsError("This thread already has a Questions request in progress.");
    asking.add(threadId);
    return () => { asking.delete(threadId); };
  }
  const service = new QuestionsService(store, {
    sdk: bb.sdk,
    log: bb.log,
    publish: (signal: ChangeSignal) => bb.realtime.publish(REALTIME_CHANNEL, signal),
    deliverInteraction: (submission, confirmed) => interactions.deliver(submission, confirmed),
  });
  const recovered = service.recoverStalePending();
  if (recovered > 0) bb.log.warn(`${recovered} submission(s) were pending at startup and are now uncertain`);
  bb.events.on("thread.deleted", ({ thread }) => store.deleteThread(thread.id));

  bb.rpc.register(rpcContract, {
    questions_state: ({ threadId }) => service.state(threadId),
    questions_round: ({ threadId, roundId }) => {
      const state = service.state(threadId);
      const round = state.rounds.find((item) => item.id === roundId) ?? null;
      const labels: Record<string, string> = {};
      if (round) {
        const ordered = [...state.rounds].sort((a, b) => a.number - b.number);
        let index = 0;
        for (const item of ordered) {
          for (const question of item.questions) {
            index += 1;
            if (item.id === round.id) labels[question.id] = `Q${index}`;
          }
        }
      }
      const ids = new Set(round?.questions.map((question) => question.id) ?? []);
      return { round, answers: state.answers.filter((item) => ids.has(item.questionId)), labels };
    },
    questions_save_draft: (input) => service.saveDraft(input),
    questions_upload_attachment: (input) => service.uploadAttachment(input),
    questions_attachment_preview: async (input) => {
      const result = await service.readAttachmentPreview(input);
      return { dataUrl: result.dataUrl };
    },
    questions_search_paths: ({ threadId, query }) => service.searchPaths(threadId, query),
    questions_submit: (input) => service.submit(input),
  });

  const askInstructions = [
    "Use questions_ask when you need several answers from the user before you continue.",
    "The call waits for the user. The plugin renews the one-hour BB interaction on timeout while the call remains active. Questions are required unless optional is true. The user submits a complete round, not partial answers.",
    "Read the returned answers and continue. Use questions_image for submitted images; image paths alone do not show their contents. On cancellation or failure, do not automatically ask again. Drafts remain saved; late submissions arrive as user messages. Call questions_read for complete submitted records and attachment paths.",
    'Prefer mode "panel". Use mode "inline" only for up to 5 quick questions that need no attachments, references, or citations.',
    "For the quick single question that BB already offers, keep using the built-in question tool if it is available.",
  ].join(" ");

  bb.agents.registerTool({
    name: "questions_ask",
    description:
      "Ask a round of questions and wait for the user through BB's native interaction. Required by default; optional questions may be skipped. Renews on hourly timeout until answered or cancelled.",
    instructions: askInstructions,
    parameters: askToolSchema,
    presentation: {
      label: { pending: "Asking questions", completed: "Asked questions" },
      icon: { glyph: "MessageQuestion" },
    },
    async execute(params, ctx) {
      let release: (() => void) | undefined;
      try {
        release = claimAsk(ctx.threadId);
        const pending = await bb.sdk.threads.interactions.list({ threadId: ctx.threadId });
        if (pending.some((item) => item.status === "pending" || item.status === "resolving")) throw new QuestionsError("This thread already has a pending interaction. Finish it before asking another round.");
        const result = service.ask(ctx.threadId, ctx.projectId, params);
        const response = await interactions.wait(result.round, ctx.signal);
        if ("outcome" in response) return {
          content: [{ type: "text", text: `Questions ended: ${response.outcome === "cancelled" ? response.reason : "invalid response"}. Round ${result.round.id} and its drafts are saved. Do not ask again automatically; wait for the user.` }], isError: true,
        };
        // Return the frozen snapshot, never the current editable drafts.
        const text = JSON.stringify({ round: result.round.id, submissionId: response.id,
          answers: result.round.questions.map((q, i) => ({ label: result.labels[i], title: q.title,
            optional: q.optional ?? false, skipped: Boolean(q.optional && !hasContent(response.snapshot[q.id])), answer: response.snapshot[q.id] })),
          note: "Use questions_image with the question label and path to view each submitted image. Use questions_read for stored records." });
        return Buffer.byteLength(text, "utf8") <= 512 * 1024 ? text
          : `Round ${result.round.id} submitted (${response.id}). Call questions_read with round=${result.round.id} and follow its cursors to read all submitted answers.`;
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      } finally {
        release?.();
      }
    },
  });

  bb.agents.registerTool({
    name: "questions_image",
    description: "View one image the user submitted in Questions. Unsubmitted draft images are not accessible.",
    parameters: z.object({ question: z.string().min(1), path: z.string().min(1) }),
    async execute({ question, path }, ctx) {
      try { return await service.submittedImage(ctx.threadId, question, path); }
      catch (error) { return { content: [{ type: "text", text: errorMessage(error) }], isError: true }; }
    },
  });

  bb.agents.registerTool({
    name: "questions_read",
    description:
      "Read every answer the user submitted in this thread's Questions, with thread-wide labels (Q1, Q2, …). Drafts the user has not submitted are reported only as pending.",
    parameters: z.object({
      round: z.string().optional().describe("Limit to one round id. Omit for every round."),
      after: z.string().optional().describe("Continue after the question ID from the previous page. Complete submitted records are returned; drafts are not."),
    }),
    presentation: {
      label: { pending: "Reading answers", completed: "Read answers" },
      icon: { glyph: "MessageQuestion" },
      suppress: true,
    },
    execute(params, ctx) {
      return service.read(ctx.threadId, params.round ?? null, params.after ?? null);
    },
  });

  bb.agents.registerTool({
    name: "questions_summary",
    description:
      "Set or clear the short markdown summary shown on the Summary tab of this thread's Questions: the goal, the current direction, and what is still open.",
    parameters: z.object({
      summary: z
        .string()
        .max(LIMITS.summaryChars)
        .nullable()
        .describe("Markdown, at most 8000 characters. Pass null to clear."),
    }),
    presentation: {
      label: { pending: "Updating summary", completed: "Updated summary" },
      icon: { glyph: "MessageQuestion" },
      suppress: true,
    },
    execute(params, ctx) {
      try {
        service.setSummary(ctx.threadId, params.summary);
        return params.summary === null ? "Summary cleared." : "Summary updated.";
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb questions ask [--thread <id>] [--inline] [--intro <text>] <title> [--option <label>]... [--multiple] [--json]",
    "  bb questions ask [--thread <id>] --file <questions.json> [--host <id>] [--json]",
    "  bb questions read [--thread <id>] [--round <id>] [--after <question-id>]",
    "  bb questions rounds [--thread <id>] [--json]",
    "  bb questions summary [--thread <id>] set <markdown> | clear | show",
    "",
    "The thread defaults to the thread the command runs in (BB_THREAD_ID).",
    "--file reads on the invoking thread's machine. Outside a thread, pass --host and an absolute file path.",
    "questions.json holds the same object questions_ask accepts:",
    '  {"mode":"panel","intro":"…","questions":[{"title":"…","options":["A","B"],"select":"single"}]}',
  ].join("\n");

  interface ParsedArgs {
    flags: Map<string, string[]>;
    booleans: Set<string>;
    positionals: string[];
  }
  const VALUE_FLAGS = new Set(["thread", "intro", "option", "file", "round", "host", "after"]);
  function parseArgs(argv: string[]): ParsedArgs {
    const flags = new Map<string, string[]>();
    const booleans = new Set<string>();
    const positionals: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index] as string;
      if (!arg.startsWith("--")) {
        positionals.push(arg);
        continue;
      }
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const value = argv[index + 1];
        if (value === undefined) throw new QuestionsError(`--${name} needs a value.`);
        flags.set(name, [...(flags.get(name) ?? []), value]);
        index += 1;
      } else if (["json", "inline", "multiple", "help"].includes(name)) {
        booleans.add(name);
      } else {
        throw new QuestionsError(`Unknown option --${name}.`);
      }
    }
    return { flags, booleans, positionals };
  }

  async function resolveThread(parsed: ParsedArgs, ctxThreadId: string | undefined) {
    const threadId = parsed.flags.get("thread")?.[0] ?? ctxThreadId;
    if (threadId === undefined) {
      throw new QuestionsError("No thread. Pass --thread <id> or run inside a BB thread.");
    }
    const thread = await bb.sdk.threads.get({ threadId });
    return { threadId, projectId: thread.projectId };
  }

  bb.cli.register({
    name: "questions",
    summary: "Ask and read structured questions in a thread's Questions",
    commands: [
      {
        name: "ask",
        summary: "Create a round of questions in a thread (quick form or --file JSON)",
        usage: "bb questions ask [--thread <id>] [--inline] <title> [--option <label>]... | --file <questions.json>",
      },
      {
        name: "read",
        summary: "Print every submitted answer with its Q label",
        usage: "bb questions read [--thread <id>] [--round <id>] [--after <question-id>]",
      },
      {
        name: "rounds",
        summary: "List rounds and their submission counts",
        usage: "bb questions rounds [--thread <id>] [--json]",
      },
      {
        name: "summary",
        summary: "Set, clear, or show the Summary tab text",
        usage: "bb questions summary [--thread <id>] set <markdown> | clear | show",
      },
    ],
    async run(argv, ctx) {
      let release: (() => void) | undefined;
      try {
        const parsed = parseArgs(argv);
        const json = parsed.booleans.has("json");
        const [command, ...rest] = parsed.positionals;
        if (command === undefined || command === "help" || parsed.booleans.has("help")) return { exitCode: 0, stdout: usage };
        const { threadId, projectId } = await resolveThread(parsed, ctx.threadId);
        switch (command) {
          case "ask": {
            release = claimAsk(threadId);
            let input: unknown;
            const file = parsed.flags.get("file")?.[0];
            if (file !== undefined) {
              let hostId = parsed.flags.get("host")?.[0];
              if (!hostId && ctx.threadId) {
                const caller = await bb.sdk.threads.get({ threadId: ctx.threadId });
                if (caller.environmentId) {
                  const environment = await bb.sdk.environments.get({ environmentId: caller.environmentId });
                  hostId = environment.hostId;
                }
              }
              if (!hostId) throw new QuestionsError("Cannot resolve the file's machine. Pass --host <id>.");
              const filePaths = /^[A-Za-z]:[\\/]|^\\\\/.test(file) || /^[A-Za-z]:[\\/]|^\\\\/.test(ctx.cwd ?? "") ? path.win32 : path.posix;
              if (!filePaths.isAbsolute(file) && (!ctx.cwd || parsed.flags.has("host"))) {
                throw new QuestionsError("Use an absolute --file path when no invoking working directory is available or --host is set.");
              }
              const filePath = filePaths.isAbsolute(file) ? file : filePaths.resolve(ctx.cwd as string, file);
              const source = await bb.sdk.files.read({ hostId, path: filePath, signal: ctx.signal });
              if (source.contentEncoding !== "utf8") throw new QuestionsError("Questions JSON must be a UTF-8 text file.");
              if (Buffer.byteLength(source.content, "utf8") > LIMITS.roundQuestionsBytes) throw new QuestionsError("Questions JSON exceeds the round byte limit.");
              input = JSON.parse(source.content);
            } else {
              const title = rest.join(" ").trim();
              if (title === "") return { exitCode: 1, stderr: usage };
              const options = parsed.flags.get("option") ?? [];
              input = {
                mode: parsed.booleans.has("inline") ? "inline" : "panel",
                intro: parsed.flags.get("intro")?.[0],
                questions: [
                  {
                    title,
                    options: options.length > 0 ? options : undefined,
                    select: parsed.booleans.has("multiple") ? "multiple" : undefined,
                  },
                ],
              };
            }
            const pending = await bb.sdk.threads.interactions.list({ threadId });
            if (pending.some((item) => item.status === "pending" || item.status === "resolving")) throw new QuestionsError("This thread already has a pending interaction.");
            const result = service.ask(threadId, projectId, input);
            const response = await interactions.wait(result.round, ctx.signal);
            if ("outcome" in response) return { exitCode: 1, stderr: `Questions ended: ${response.outcome === "cancelled" ? response.reason : "invalid response"}. Round ${result.round.id} and its drafts are kept.` };
            return { exitCode: 0, stdout: service.read(threadId, result.round.id) };
          }
          case "read":
            return { exitCode: 0, stdout: service.read(threadId, parsed.flags.get("round")?.[0] ?? null, parsed.flags.get("after")?.[0] ?? null) };
          case "rounds": {
            const state = service.state(threadId);
            const answers = new Map(state.answers.map((item) => [item.questionId, item]));
            const rows = state.rounds.map((round) => ({
              id: round.id,
              number: round.number,
              mode: round.mode,
              questions: round.questions.length,
              submitted: round.questions.filter((question) => answers.get(question.id)?.submitted !== null && answers.get(question.id)?.submitted !== undefined).length,
              createdAt: round.createdAt,
            }));
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(rows)
                : rows.length === 0
                  ? "No rounds."
                  : rows.map((row) => `Round ${row.number}  ${row.id}  ${row.mode}  ${row.submitted}/${row.questions} submitted`).join("\n"),
            };
          }
          case "summary": {
            const [action, ...words] = rest;
            if (action === "set") {
              const markdown = words.join(" ").trim();
              if (markdown === "") return { exitCode: 1, stderr: "summary set needs text." };
              service.setSummary(threadId, markdown);
              return { exitCode: 0, stdout: "Summary updated." };
            }
            if (action === "clear") {
              service.setSummary(threadId, null);
              return { exitCode: 0, stdout: "Summary cleared." };
            }
            if (action === "show") {
              const summary = service.state(threadId).summary;
              return { exitCode: 0, stdout: summary ? summary.markdown : "No summary." };
            }
            return { exitCode: 1, stderr: usage };
          }
          default:
            return { exitCode: 1, stderr: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      } finally {
        release?.();
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
