/**
 * W605: what a worker's Claude Code session leaves out of its context.
 *
 * Turn-start context is about half of a BB thread's spend. These are the tools
 * and listed skills that Initiative workers and their child threads (reviewers,
 * helpers) don't use: counted from Skill and tool calls across 7 days of
 * transcripts (2026-11-12). A fresh session's first request, with BB's flags,
 * measured 26.6k tokens without them, 17.7k with: 6.6k from the tools, 2.3k
 * from the skills. Coordinators and user threads keep everything.
 *
 * The Claude Code provider merges BB_CLAUDE_CODE_SETTINGS into the session's
 * `--settings` layer, under BB's own flags, and leaves the hidden
 * `bb-global-skills:*` out of BB's injected skill plugin (skillOverrides only
 * reaches Claude Code's own skills). An ultracode turn runs on workflows: the
 * provider keeps Workflow and workflow-authoring in that session whatever this
 * says. An older provider passes the variable into the session's environment
 * unused.
 */
export const WORKER_SETTINGS_ENV = "BB_CLAUDE_CODE_SETTINGS";

/** How far up a thread's parents the trim looks for a worker: its helpers' helpers' helpers. */
export const MAX_WORKER_ANCESTORS = 4;

/** A deny rule drops the tool from the session, schema and all. */
const DENIED_TOOLS = ["ReportFindings", "AskUserQuestion", "ListAgents", "ScheduleWakeup"];

/**
 * Hidden from the model's skill listing; Claude Code's own stay typable as
 * /name, BB's leave the session. Kept: every skill a worker or reviewer called
 * that week, the repo's own skills, and the review, writing and BB basics
 * (principles, unslop, code-review, autoreview, debt-review, tdd,
 * decision-audit, simplify, run, agent-browser, claude-api, context7, bb-cli,
 * chat-memory, secrets, share-server-links, automations, provider-retry,
 * initiative-worker).
 */
const HIDDEN_SKILLS = [
  // Shipped with Claude Code.
  "dataviz", "fewer-permission-prompts", "init", "keybindings-help", "loop", "plugin-authoring",
  "security-review", "update-config",
  // ~/.claude/skills
  "grill",
  // BB plugins' skills
  ...[
    "account-pool-local", "bb-account", "bb-cloud-ai", "bb-plugin-authoring", "claude-code-provider",
    "codex-provider", "concurrency-limit", "executor", "inline-vis", "mcp-servers", "pi-provider",
    "plan-review", "plugin-commands", "thread-list", "thread-snooze",
  ].map((name) => `bb-global-skills:${name}`),
];

/**
 * The settings for every worker session. workflow-authoring goes with the Workflow tool: hidden
 * alone, Claude Code inlines that skill into Workflow's description (+4.9k tokens).
 */
export const WORKER_CLAUDE_SETTINGS = {
  permissions: { deny: ["Workflow", ...DENIED_TOOLS] },
  skillOverrides: Object.fromEntries(
    [...HIDDEN_SKILLS, "workflow-authoring"].map((name) => [name, "user-invocable-only"]),
  ),
};

/**
 * W615: the worker settings, plus the hook that nudges a worker to batch its reads
 * (lib/batching-nudge.ts) after each call that may read. Without a command: the trim alone.
 */
export const workerClaudeSettings = (nudgeCommand: string | null) =>
  nudgeCommand === null
    ? WORKER_CLAUDE_SETTINGS
    : {
        ...WORKER_CLAUDE_SETTINGS,
        hooks: { PostToolUse: [{ matcher: "Read|Grep|Glob|Bash", hooks: [{ type: "command", command: nudgeCommand, timeout: 5 }] }] },
      };
