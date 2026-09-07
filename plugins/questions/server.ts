// Questions plugin backend: a durable, thread-bound notebook of agent
// questions and user answers. Rounds are created by the agent tool or the
// CLI, drafts and submissions live in the plugin's SQLite database, and
// answers travel back to the owning thread as ordinary user messages.
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
} from "./lib/model";
import { MIGRATIONS, QuestionsStore } from "./server/store";
import { QuestionsError, QuestionsService } from "./server/service";

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
      retryOf: z.string().nullable(),
    }),
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
    .enum(["notebook", "inline"])
    .default("notebook")
    .describe(
      'Where the user answers. "notebook": the persistent Questions side panel, any number of questions, grouped, with optional attachments, references, confidence, and citations of earlier answers. "inline": a short card inside the thread, at most 5 questions, choices and free text only.',
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
        help: z.string().max(LIMITS.helpChars).optional().describe("Optional context under the title."),
        group: z.string().max(120).optional().describe("Notebook only: heading to group questions under."),
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
          .describe('Notebook only: labels of earlier questions ("Q3") whose submitted answers this question builds on.'),
        attachments: z.boolean().optional().describe("Notebook only: let the user attach files or images."),
        references: z.boolean().optional().describe("Notebook only: let the user pick workspace files or links."),
        confidence: z.boolean().optional().describe("Notebook only: ask for a low, medium, or high confidence."),
      }),
    )
    .min(1),
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new QuestionsStore(db);
  const service = new QuestionsService(store, {
    sdk: bb.sdk,
    log: bb.log,
    publish: (signal: ChangeSignal) => bb.realtime.publish(REALTIME_CHANNEL, signal),
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
    "The call returns at once. The user answers in their own time, so after the call: put the returned directive line alone on its own line in your reply, say nothing else about how to answer, and end your turn.",
    "Do not poll or wait in a loop. Answers arrive later as user messages that begin with 'Answers to'. Call questions_read to see every submitted answer, then ask a follow-up round if needed.",
    'Prefer mode "notebook". Use mode "inline" only for up to 5 quick questions that need no attachments, references, or citations.',
    "For the quick single question that BB already offers, keep using the built-in question tool if it is available.",
  ].join(" ");

  bb.agents.registerTool({
    name: "questions_ask",
    description:
      "Ask the user a round of structured questions in the BB Questions notebook (side panel) or inline in the thread. Returns immediately; the user submits answers later as messages.",
    instructions: askInstructions,
    parameters: askToolSchema,
    presentation: {
      label: { pending: "Asking questions", completed: "Asked questions" },
      icon: { glyph: "MessageQuestion" },
    },
    execute(params, ctx) {
      try {
        const result = service.ask(ctx.threadId, ctx.projectId, params);
        const where =
          result.round.mode === "inline"
            ? "The questions render inside your message where the directive appears."
            : "The questions open in the Questions notebook side panel.";
        return [
          `Created round ${result.round.number} (id ${result.round.id}) with ${result.labels.join(", ")}.`,
          where,
          `Put this line alone on its own line in your reply, then end your turn and wait:`,
          result.directive,
          "Answers arrive as user messages that begin with 'Answers to'. Use questions_read to list every submitted answer.",
        ].join("\n");
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "questions_read",
    description:
      "Read every answer the user submitted in this thread's Questions notebook, with thread-wide labels (Q1, Q2, …). Drafts the user has not submitted are reported only as pending.",
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
      "Set or clear the short markdown summary shown on the Summary tab of this thread's Questions notebook: the goal, the current direction, and what is still open.",
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
    '  {"mode":"notebook","intro":"…","questions":[{"title":"…","options":["A","B"],"select":"single"}]}',
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
    summary: "Ask and read structured questions in a thread's Questions notebook",
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
      try {
        const parsed = parseArgs(argv);
        const json = parsed.booleans.has("json");
        const [command, ...rest] = parsed.positionals;
        if (command === undefined || command === "help" || parsed.booleans.has("help")) return { exitCode: 0, stdout: usage };
        const { threadId, projectId } = await resolveThread(parsed, ctx.threadId);
        switch (command) {
          case "ask": {
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
                mode: parsed.booleans.has("inline") ? "inline" : "notebook",
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
            const result = service.ask(threadId, projectId, input);
            const summary = `Created round ${result.round.number} (${result.round.id}) in ${threadId}: ${result.labels.join(", ")}.\nDirective for the agent reply: ${result.directive}`;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify({ round: result.round, labels: result.labels, directive: result.directive })
                : summary,
            };
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
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
