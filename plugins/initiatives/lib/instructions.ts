import { MAX_GUIDANCE_CHARACTERS } from "./settings";

// v9 (§6.1): BB keeps at most 4096 characters of a plugin's configure() instructions and cuts the
// rest silently. Each session's instructions are the plugin's own lines (identity, a state
// note), at most PLUGIN_LINES_MAX, then the saved guidance (at most
// MAX_GUIDANCE_CHARACTERS, the settings schema's limit), so the guidance always arrives whole.

export const INSTRUCTIONS_MAX = 4096;
const SEPARATOR = "\n\n";
export const PLUGIN_LINES_MAX = INSTRUCTIONS_MAX - MAX_GUIDANCE_CHARACTERS - SEPARATOR.length;

/** A label or purpose as identity lines quote it: at most 80 characters. */
export const clip80 = (text: string) => (text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text);

export function assembleInstructions(pluginLines: (string | null | undefined)[], guidance: string | null): string {
  let head = pluginLines.filter(Boolean).join("\n");
  if (head.length > PLUGIN_LINES_MAX) head = `${head.slice(0, PLUGIN_LINES_MAX - 1)}…`;
  const body = guidance ? guidance.slice(0, MAX_GUIDANCE_CHARACTERS) : "";
  return body ? `${head}${SEPARATOR}${body}` : head;
}
