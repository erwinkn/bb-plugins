/** Each pattern owns its replacement so assignment keys are preserved. */
export const REDACTION_PATTERNS = [
  { name: "pem", pattern: /-----BEGIN ([A-Z0-9][A-Z0-9 -]*?) ?-----[\s\S]*?-----END \1 ?-----/g, replacement: "[redacted]" },
  { name: "openai", pattern: /sk-[A-Za-z0-9_-]{16,}/g, replacement: "[redacted]" },
  { name: "github", pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: "[redacted]" },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted]" },
  { name: "aws", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[redacted]" },
  { name: "slack", pattern: /xox[bpoas]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted]" },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, replacement: "[redacted]" },
  { name: "assignment", pattern: /^([\t ]*(?:[A-Za-z_][A-Za-z0-9_]*?)?(?:KEY|TOKEN|SECRET|PASSWORD)[\t ]*[:=][\t ]*)(\S{16,})([\t ]*)$/gm, replacement: "$1[redacted]$3" },
] as const;

export function redact(text: string): string {
  return REDACTION_PATTERNS.reduce((value, { pattern, replacement }) => value.replace(pattern, replacement), text);
}
