export interface LineRange { start: number; end: number }

export function normalizeQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

/** Preserve source line numbers while searching rendered Markdown text. */
export function quoteLineRange(markdown: string, quote: string): LineRange | null {
  const needle = normalizeQuote(quote);
  if (!needle) return null;
  let fence: string | null = null;
  const lines = markdown.split(/\r?\n/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker; return "";
    }
    if (fence) return normalizeQuote(line);
    const code: string[] = [];
    const protectedLine = line.replace(/(`+)([\s\S]*?)\1(?!`)/g, (_, _ticks: string, content: string) => {
      code.push(content); return `\u0000${code.length - 1}\u0000`;
    });
    return normalizeQuote(protectedLine.replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(?<!\w)([*_])(.+?)\1(?!\w)/g, "$2")
      .replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]!));
  });
  const offsets: number[] = [];
  let source = "";
  lines.forEach((line, index) => {
    if (!line) return;
    if (source) { source += " "; offsets.push(index + 1); }
    source += line;
    for (let offset = 0; offset < line.length; offset += 1) offsets.push(index + 1);
  });
  const start = source.indexOf(needle);
  if (start < 0 || source.indexOf(needle, start + 1) >= 0) return null;
  return { start: offsets[start]!, end: offsets[start + needle.length - 1]! };
}
