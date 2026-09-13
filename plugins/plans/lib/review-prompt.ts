const titleLimit = 56;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep the host's plain-text heading short; the plan and payload keep the full title. */
export function reviewPromptTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const parts = Array.from(graphemes.segment(normalized), ({ segment }) => segment);
  if (parts.length <= titleLimit) return normalized;
  const prefix = parts.slice(0, titleLimit - 1).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  // Prefer a complete word, but still bound titles made of one long token.
  const shortened = parts[titleLimit - 1] !== " " && lastSpace >= prefix.length / 2
    ? prefix.slice(0, lastSpace) : prefix;
  return `${shortened.trimEnd()}…`;
}
