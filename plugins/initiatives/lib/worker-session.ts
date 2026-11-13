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
 * unused; one older than W617 voids a value that sets deniedMcpServers.
 */
export const WORKER_SETTINGS_ENV = "BB_CLAUDE_CODE_SETTINGS";

/** How far up a thread's parents the trim looks for a worker: its helpers' helpers' helpers. */
export const MAX_WORKER_ANCESTORS = 4;

/**
 * A deny rule drops the tool from the session, schema and all, or its name from the deferred
 * listing. W617: the deferred tools and the agent type no worker or reviewer called in 7 days
 * (2026-11-13); the MCP resource tools come with any MCP server.
 */
const DENIED_TOOLS = [
  "ReportFindings", "AskUserQuestion", "ListAgents", "ScheduleWakeup",
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree", "ExitWorktree", "NotebookEdit",
  "PushNotification", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
  "Agent(statusline-setup)",
];

/**
 * Hidden from the model's skill listing; Claude Code's own stay typable as
 * /name, BB's leave the session. Kept: every skill workers or reviewers called
 * at least 5 times in 7 days (2026-11-13: agent-browser, autoreview,
 * bb-global-skills:automations and :provider-retry), the review and writing
 * basics (principles, unslop, code-review, debt-review, decision-audit), and
 * the repo's own skills. OPTIONAL_SKILLS come back when named.
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
 * `name` as a whole word, not part of a longer name such as simplify-review. Underscores
 * bound it too, so a qualified MCP tool name (mcp__axiom__queryDataset) names its server.
 */
const named = (name: string) => new RegExp(`(?<![a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![a-z0-9-])`, "i");

/**
 * W617: listed only when the worker's brief or its checkout's CLAUDE.md or AGENTS.md names
 * them. Workers and reviewers called each at most 3 times in 7 days (2026-11-13). The BB
 * ones repeat what the session already says: the worker guidance and the bb plugins'
 * instructions cover the Initiative, chat memory and the bb CLI.
 */
const OPTIONAL_SKILLS: Record<string, RegExp> = {
  "claude-api": named("claude-api"),
  context7: named("context7"),
  simplify: named("simplify"),
  tdd: named("tdd"),
  run: named("/run"),
  ...Object.fromEntries(
    ["bb-cli", "chat-memory", "initiative-worker", "secrets", "share-server-links"].map((name) => [`bb-global-skills:${name}`, named(name)]),
  ),
};

/**
 * W617: user-level MCP servers whose tool names and instructions (12 KB together) a session
 * carries only when the worker's brief or its checkout's CLAUDE.md or AGENTS.md names them.
 * Briefs alone miss real use: of the 204 equisafe-market worker threads that called Axiom in
 * 7 days (2026-11-13), 81 had a brief that never named it. That repo's CLAUDE.md sends agents
 * to Axiom and equisafe.dev, so its workers keep both.
 */
const OPTIONAL_MCP_SERVERS: Record<string, RegExp> = {
  axiom: named("axiom"),
  "equisafe-dev": /(?<![a-z0-9-])equisafe[-.]dev(?![a-z0-9-])/i,
};

/**
 * W617: servers fewer than 10% of workers call load only when the brief names them; a
 * checkout's instruction files don't count. Of 704 equisafe-market worker threads in 7 days
 * (2026-11-13), 48 (6.8%) called Sentry, against 29.0% for Axiom and 14.8% for equisafe-dev.
 */
const BRIEF_MCP_SERVERS: Record<string, RegExp> = {
  sentry: named("sentry"),
};

/**
 * The settings for a worker session with this brief and checkout instructions; `checkout` is
 * null when they could not be read, which keeps every optional server and skill they could name.
 * workflow-authoring goes with the Workflow tool: hidden alone, Claude Code inlines that skill
 * into Workflow's description (+4.9k tokens). W615: with a command, the hook that nudges a
 * worker to batch its reads (lib/batching-nudge.ts) after each call that may read.
 */
export function workerClaudeSettings(brief: string, checkout: string | null, nudgeCommand: string | null) {
  const text = checkout === null ? null : `${brief}\n${checkout}`;
  const unnamed = (optional: Record<string, RegExp>, text: string | null) =>
    text === null ? [] : Object.keys(optional).filter((name) => !optional[name]!.test(text));
  const deniedMcpServers = [...unnamed(OPTIONAL_MCP_SERVERS, text), ...unnamed(BRIEF_MCP_SERVERS, brief)]
    .map((serverName) => ({ serverName }));
  return {
    permissions: { deny: ["Workflow", ...DENIED_TOOLS] },
    skillOverrides: Object.fromEntries(
      [...HIDDEN_SKILLS, "workflow-authoring", ...unnamed(OPTIONAL_SKILLS, text)].map((name) => [name, "user-invocable-only"]),
    ),
    ...(deniedMcpServers.length ? { deniedMcpServers } : {}),
    ...(nudgeCommand === null
      ? {}
      : { hooks: { PostToolUse: [{ matcher: "Read|Grep|Glob|Bash", hooks: [{ type: "command", command: nudgeCommand, timeout: 5 }] }] } }),
  };
}

/** The instruction files Claude Code loads from a checkout's root, read for the names above. */
export const CHECKOUT_INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md"];

/**
 * How long a session start waits for a checkout's first read. BB drops a provider's whole env
 * contribution after 5 s, and a file read on a remote host can take 30.
 */
export const CHECKOUT_READ_MS = 2_000;
