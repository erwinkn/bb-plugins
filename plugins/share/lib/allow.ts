export type AllowEntry = string & { readonly __allowEntry: unique symbol };

const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const local = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** Accept conventional email addresses and @domain entries, without wildcards. */
export function normalizeEntry(input: string): AllowEntry {
  const entry = input.trim().toLowerCase();
  const parts = entry.split("@");
  if (parts.length !== 2 || entry.length > 254 || !domain.test(parts[1]!)
    || (parts[0] !== "" && (parts[0]!.length > 64 || !local.test(parts[0]!)))) {
    throw new Error(`Invalid allow list entry: ${JSON.stringify(input)}.`);
  }
  return entry as AllowEntry;
}

export function normalizeEntries(entries: string[]): string[] {
  return [...new Set(entries.map(normalizeEntry))];
}

export function matches(entries: readonly string[], email: string | null): boolean {
  if (entries.length === 0) return true;
  if (!email) return false;
  let candidate: string;
  try { candidate = normalizeEntry(email); } catch { return false; }
  if (candidate.startsWith("@")) return false;
  const suffix = candidate.slice(candidate.lastIndexOf("@"));
  return entries.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === candidate || normalized === suffix;
  });
}
