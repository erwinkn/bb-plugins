// bb prompt input → Muse turn input, and bb instructions → Muse's developer
// prompt.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mimeTypeFromExtension, type PromptInput } from "@get-bb/plugin-sdk/provider-bridge";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN). Instructions that
 * would not fit travel as a file the prompt points at.
 */
const MAX_INLINE_PROMPT_BYTES = 96 * 1024;

export type MuseInputPart =
  | { type: "text"; text: string }
  | { type: "image"; base64Data: string; mediaType: string };

export interface MuseTurnInput {
  input: MuseInputPart[];
  /** What the transcript shows; agent-only text stays model-visible only. */
  displayText: string;
}

function dataUrlImage(url: string): MuseInputPart | null {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  if (match === null) return null;
  return { type: "image", mediaType: match[1] ?? "image/png", base64Data: match[2] ?? "" };
}

function localImage(path: string): MuseInputPart | string {
  try {
    if (statSync(path).size > MAX_IMAGE_BYTES) return `[Image too large to attach: ${path}]`;
    return {
      type: "image",
      mediaType: mimeTypeFromExtension(path),
      base64Data: readFileSync(path).toString("base64"),
    };
  } catch (error) {
    return `[Image unreadable: ${path} (${error instanceof Error ? error.message : String(error)})]`;
  }
}

export function museTurnInput(prompt: readonly PromptInput[]): MuseTurnInput {
  const text: string[] = [];
  const display: string[] = [];
  const images: MuseInputPart[] = [];
  for (const part of prompt) {
    switch (part.type) {
      case "text":
        text.push(part.text);
        if (part.visibility !== "agent-only") display.push(part.text);
        break;
      case "image": {
        const image = dataUrlImage(part.url);
        if (image === null) text.push(`\n[Image: ${part.url}]`);
        else images.push(image);
        break;
      }
      case "localImage": {
        const image = localImage(part.path);
        if (typeof image === "string") text.push(`\n${image}`);
        else images.push(image);
        break;
      }
      case "localFile":
        text.push(`\n[Attached file: ${part.path}${part.name ? ` (${part.name})` : ""}]`);
        break;
    }
  }
  const joined = text.join("");
  return {
    input: [...(joined.length > 0 ? [{ type: "text" as const, text: joined }] : []), ...images],
    displayText: display.join(""),
  };
}

export interface SkillRoot {
  path: string;
  skills: ReadonlyArray<{ name: string; description: string }>;
}

/**
 * bb's skills, listed for the model. Muse has no setting for extra skill
 * directories, so the catalog rides the developer prompt and the model reads
 * a skill's SKILL.md with its own file tool when it needs one.
 */
function skillsCatalog(roots: readonly SkillRoot[]): string {
  const lines = roots.flatMap((root) =>
    root.skills.map(
      (skill) => `- ${skill.name}: ${skill.description.replace(/\s+/gu, " ").trim()} (${join(root.path, skill.name, "SKILL.md")})`,
    ),
  );
  if (lines.length === 0) return "";
  return [
    "# bb skills",
    "",
    "These skills come from bb, the app running this session. When a task matches one, read its SKILL.md with read_file and follow it.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * The developer prompt for a session: bb's instructions, then bb's skills.
 * Returns null when there is nothing to add.
 */
export function developerPrompt(args: {
  instructions: string | undefined;
  skills: readonly SkillRoot[];
  spillDir: string;
  threadId: string;
}): string | null {
  const sections = [args.instructions?.trim() ?? "", skillsCatalog(args.skills)].filter(
    (section) => section.length > 0,
  );
  if (sections.length === 0) return null;
  const prompt = sections.join("\n\n");
  if (Buffer.byteLength(JSON.stringify(prompt)) <= MAX_INLINE_PROMPT_BYTES) return prompt;
  const file = join(args.spillDir, `instructions-${args.threadId.replace(/[^A-Za-z0-9_-]/gu, "_")}.md`);
  writeFileSync(file, prompt);
  return `Your instructions from bb, the app running this session, are in ${file}. Read the whole file with read_file before you do anything else, and follow it as you would a system prompt.`;
}
