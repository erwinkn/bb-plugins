import { PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ShareService } from "./service";

const COMMANDS = [
  { name: "create", summary: "Create a read-only share (sign-in required by default)", usage: "bb share create [thread] [--public] [--allow <email-or-@domain>]... [--tools] [--expires <days>|never] [--json]" },
  { name: "allow", summary: "Add allowed emails or domains", usage: "bb share allow <share-id> <entry>... [--json]" },
  { name: "disallow", summary: "Remove allowed emails or domains", usage: "bb share disallow <share-id> <entry>... [--json]" },
  { name: "list", summary: "List a thread's shares", usage: "bb share list [thread] [--json]" },
  { name: "revoke", summary: "Revoke a share", usage: "bb share revoke <share-id> [--json]" },
  { name: "status", summary: "Show sharing configuration", usage: "bb share status [--json]" },
];
const usage = COMMANDS.map((command) => command.usage).join("\n") + "\n[thread] defaults to BB_THREAD_ID. Tool output can contain file contents, paths, and logs.";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    if (["--json", "--public", "--tools", "--help"].includes(arg)) { booleans.add(arg); continue; }
    if (!["--allow", "--expires"].includes(arg)) throw new Error(`Unknown option ${arg}.`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
    if (arg === "--expires" && flags.has(arg)) throw new Error("--expires may only be supplied once.");
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return { flags, booleans, positionals };
}
function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") > Math.min(256 * 1024, PLUGIN_CLI_OUTPUT_MAX_BYTES)) {
    throw new Error("Share output exceeds the CLI limit; use the share_list RPC to read this thread's shares.");
  }
  return text;
}
function oneLine(text: string): string { return text.replace(/[\u0000-\u001f\u007f]/g, " "); }

export function registerCli(bb: BbPluginApi, service: ShareService): void {
  bb.cli.register({
    name: "share", summary: "Share threads as read-only pages", commands: COMMANDS,
    async run(argv, ctx) {
      try {
        const parsed = parseArgs(argv);
        const [command, ...args] = parsed.positionals;
        if (!command || command === "help" || parsed.booleans.has("--help")) return { exitCode: 0, stdout: usage };
        if (command !== "create" && (parsed.flags.size || parsed.booleans.has("--public") || parsed.booleans.has("--tools"))) throw new Error("Share creation options require the create command.");
        const json = parsed.booleans.has("--json");
        let value: unknown;
        let human: string;
        const thread = () => {
          if (args.length > 1) throw new Error("Expected at most one thread ID.");
          const id = args[0] ?? ctx.threadId;
          if (!id) throw new Error("Pass a thread ID or run inside a BB thread (BB_THREAD_ID).");
          return id;
        };
        switch (command) {
          case "create": {
            const expires = parsed.flags.get("--expires")?.[0];
            if (expires !== undefined && expires !== "never" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(expires)) throw new Error("--expires needs non-negative days or never.");
            const result = await service.create({ threadId: thread(), visibility: parsed.booleans.has("--public") ? "public" : "access",
              allowedEmails: parsed.flags.get("--allow"), includeTools: parsed.booleans.has("--tools"),
              expiresInDays: expires === undefined ? undefined : expires === "never" ? null : Number(expires) });
            value = result; human = result.share.url; break;
          }
          case "list": {
            const result = await service.list(thread());
            value = result;
            human = result.shares.length === 0 ? "No shares." : ["ID  MODE  STATE  VIEWS  CREATED  URL", ...result.shares.map((share) =>
              `${share.id}  ${share.visibility}  ${share.state}  ${share.viewCount}  ${new Date(share.createdAt).toISOString()}  ${share.url}`)].join("\n");
            break;
          }
          case "status": {
            if (args.length) throw new Error("status takes no arguments.");
            const status = await service.status();
            value = status; human = Object.entries(status).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") || "none" : value ?? "unset"}`).join("\n"); break;
          }
          case "allow": case "disallow": {
            const [id, ...entries] = args;
            if (!id || !entries.length) throw new Error(`${command} needs a share ID and one or more entries.`);
            const result = await service.changeAllow(id, entries, command === "disallow");
            value = result; human = result.share.visibility === "public" ? `${id}: public links ignore allow lists.`
              : `${id}: ${result.share.allowedEmails.join(", ") || "anyone who can sign in"}`; break;
          }
          case "revoke": {
            if (args.length !== 1) throw new Error("revoke needs one share ID.");
            const share = service.store.get(args[0]!);
            if (!share) throw new Error("Unknown share.");
            value = await service.revoke({ threadId: share.threadId, shareId: share.id });
            human = `Revoked ${share.id}.`; break;
          }
          default: throw new Error(`Unknown command ${command}. Run bb share --help.`);
        }
        return { exitCode: 0, stdout: bounded(json ? JSON.stringify(value) : human.split("\n").map(oneLine).join("\n")) };
      } catch (error) {
        const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join("; ")
          : error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: oneLine(message).slice(0, 1000) };
      }
    },
  });
}
