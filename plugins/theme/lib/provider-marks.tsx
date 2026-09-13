/**
 * Provider brand marks drawn as inline SVG so they can carry a color (BB's own
 * provider logos render as `currentColor` masks). Registered through
 * `app.slots.experimental_providerIcon` in `app.tsx`; disabling the plugin
 * falls back to BB's masks.
 *
 * The artwork is the official mark each provider ships, taken verbatim from
 * BB 0.43.1's bundled provider plugins (`plugins/provider-*\/icons/*.svg` in
 * the BB source), from our own Devin plugin (`plugins/devin/assets/devin.svg`)
 * or, for Codex, from OpenAI's Codex app icon supplied as an SVG (see
 * `CodexMark`). Nothing is redrawn: monochrome marks only change color, and
 * the Codex cloud keeps its own gradient. Providers whose mark is not
 * available here keep BB's mask.
 *
 * Each mark has a `--bbp-brand-*` token in `themes/color.css` (light and
 * dark values) with a BB token as the fallback so the mark still reads
 * sensibly when the BB Color palette is not selected. Monochrome marks are
 * painted with that token (`paint: "token"`); a mark that carries its own
 * official colors (`paint: "artwork"`) ignores it, and the token then only
 * names the brand's flat accent for anything that needs a single color.
 * Brands with a known accent (Anthropic terracotta, Codex blue) use it;
 * monochrome brands (Cursor, xAI, opencode, Devin) render at full ink
 * strength until an official accent is supplied.
 */
import { useId, type ComponentType, type ReactNode } from "react";

export interface ProviderMark {
  /** BB provider id (declaration id, not plugin id). */
  providerId: string;
  /** Provider display name, for docs. */
  label: string;
  /** Color token defined in themes/color.css for light and dark. */
  token: `--bbp-brand-${string}`;
  /** BB token (defined in both modes) used when the palette is not selected. */
  fallback: `--${string}`;
  /** `token`: painted with the brand token; `artwork`: carries its own official colors. */
  paint: "token" | "artwork";
  /** Where the artwork comes from. */
  source: string;
  icon: ComponentType<{ className?: string }>;
}

/** Inline color value: brand token with a BB fallback. */
export function markColor(token: string, fallback: string): string {
  return `var(${token}, var(${fallback}))`;
}

interface MarkProps {
  className?: string;
  viewBox: string;
  /** Brand color for a monochrome mark; omit when the artwork paints itself. */
  color?: string;
  fillRule?: "evenodd" | "nonzero";
  clipRule?: "evenodd" | "nonzero";
  children: ReactNode;
}

function Mark({ className, viewBox, color, fillRule, clipRule, children }: MarkProps) {
  return (
    <svg
      viewBox={viewBox}
      className={className}
      style={color === undefined ? undefined : { color }}
      fill={color === undefined ? undefined : "currentColor"}
      fillRule={fillRule}
      clipRule={clipRule}
      aria-hidden="true"
      focusable="false"
      data-bbp-provider-mark=""
    >
      {children}
    </svg>
  );
}

/** Claude Code: BB plugins/provider-claude-code/icons/claude-code.svg (Anthropic spark). */
function ClaudeCodeMark({ className }: { className?: string }) {
  return (
    <Mark className={className} viewBox="0 0 149 149" color={markColor("--bbp-brand-claude", "--warning-text")}>
      <path d="M29.05 98.54L58.19 82.19L58.68 80.77L58.19 79.98H56.77L51.9 79.68L35.25 79.23L20.81 78.63L6.82 77.88L3.3 77.13L0 72.78L0.340004 70.61L3.3 68.62L7.54 68.99L16.91 69.63L30.97 70.6L41.17 71.2L56.28 72.77H58.68L59.02 71.8L58.2 71.2L57.56 70.6L43.01 60.74L27.26 50.32L19.01 44.32L14.55 41.28L12.3 38.43L11.33 32.21L15.38 27.75L20.82 28.12L22.21 28.49L27.72 32.73L39.49 41.84L54.86 53.16L57.11 55.03L58.01 54.39L58.12 53.94L57.11 52.25L48.75 37.14L39.83 21.77L35.86 15.4L34.81 11.58C34.44 10.01 34.17 8.69 34.17 7.08L38.78 0.820007L41.33 0L47.48 0.820007L50.07 3.07001L53.89 11.81L60.08 25.57L69.68 44.28L72.49 49.83L73.99 54.97L74.55 56.54H75.52V55.64L76.31 45.1L77.77 32.16L79.19 15.51L79.68 10.82L82 5.2L86.61 2.16L90.21 3.88L93.17 8.12L92.76 10.86L91 22.3L87.55 40.22L85.3 52.22H86.61L88.11 50.72L94.18 42.66L104.38 29.91L108.88 24.85L114.13 19.26L117.5 16.6H123.87L128.56 23.57L126.46 30.77L119.9 39.09L114.46 46.14L106.66 56.64L101.79 65.04L102.24 65.71L103.4 65.6L121.02 61.85L130.54 60.13L141.9 58.18L147.04 60.58L147.6 63.02L145.58 68.01L133.43 71.01L119.18 73.86L97.96 78.88L97.7 79.07L98 79.44L107.56 80.34L111.65 80.56H121.66L140.3 81.95L145.17 85.17L148.09 89.11L147.6 92.11L140.1 95.93L129.98 93.53L106.36 87.91L98.26 85.89H97.14V86.56L103.89 93.16L116.26 104.33L131.75 118.73L132.54 122.29L130.55 125.1L128.45 124.8L114.84 114.56L109.59 109.95L97.7 99.94H96.91V100.99L99.65 105L114.12 126.75L114.87 133.42L113.82 135.59L110.07 136.9L105.95 136.15L97.48 124.26L88.74 110.87L81.69 98.87L80.83 99.36L76.67 144.17L74.72 146.46L70.22 148.18L66.47 145.33L64.48 140.72L66.47 131.61L68.87 119.72L70.82 110.27L72.58 98.53L73.63 94.63L73.56 94.37L72.7 94.48L63.85 106.63L50.39 124.82L39.74 136.22L37.19 137.23L32.77 134.94L33.18 130.85L35.65 127.21L50.39 108.46L59.28 96.84L65.02 90.13L64.98 89.16H64.64L25.49 114.58L18.52 115.48L15.52 112.67L15.89 108.06L17.31 106.56L29.08 98.46L29.04 98.5L29.05 98.54Z" />
    </Mark>
  );
}

/**
 * Codex: OpenAI's Codex app icon, the six-lobed cloud with the `>_` prompt
 * cut out, from the SVG Erwin supplied (2026-09-13; the official marks BB
 * and the Codex packages ship are the OpenAI knot or the knot inside this
 * cloud outline, never the plain cloud). Trimmed by hand from that file:
 * editor metadata, the unused gradient template, the style class and the
 * gradient matrix are gone and the numbers are normalized; the shape and
 * the official lavender-to-blue gradient are unchanged. The prompt is a
 * cut-out in the supplied file; the app icon shows it white, so the same
 * two subpaths are filled white underneath (Erwin, 2026-09-13). The
 * gradient is the mark's own color, so `--bbp-brand-codex` is not applied
 * here. Each
 * instance gets its own gradient id (`useId`) so several marks on one page,
 * some possibly hidden, never share a paint server.
 */
function CodexMark({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <Mark className={className} viewBox="0 0 250 250">
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="125" y1=".332" x2="125" y2="249.667">
          <stop stopColor={CODEX_GRADIENT[0]} />
          <stop offset=".5" stopColor={CODEX_GRADIENT[1]} />
          <stop offset="1" stopColor={CODEX_GRADIENT[2]} />
        </linearGradient>
      </defs>
      <path fill="#fff" d="M132.6 151.5c-2.3 .1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3 .9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4 .1 4.8-.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zM75.9 86.6c-1.2-1.9-3-3.4-5.3-3.9-2.2-.5-4.5-.3-6.5 .9-2 1.1-3.5 3-4.1 5.2-.7 2.2-.4 4.6 .6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8 .7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7 .9 2.2-.5 4.2-1.9 5.4-3.9l20.1-34.1q.7-.9 .9-2.1 .3-1.1 .3-2.3 0-1.2-.3-2.2-.2-1.2-.8-2.2z" />
      <path fill={`url(#${gradient})`} d="m84.3 5.1q3.7-1.5 7.7-2.6 3.9-1 7.9-1.6 4-.5 8.1-.6 4 0 8 .5 20.7 2.4 37.1 17.7 .1 .1 .4 .3 .1 0 .2 0 0 0 .2 0 0 0 .1 0 0 0 .1 0 5.2-1.4 10.7-1.9 5.4-.4 10.7 .1 5.5 .4 10.7 1.9 5.2 1.3 10.1 3.6l.6 .4 1.6 .8q5.2 2.5 9.7 6.1 4.7 3.4 8.6 7.7 3.8 4.3 6.9 9.2 3 4.8 5.2 10.2 4.3 10.5 4.3 22.1 .2 2.1 0 4.2-.1 2.2-.2 4.3-.3 2.1-.7 4.3-.4 2.1-.9 4.1 0 .2 0 .4 0 .2 0 .5 0 .1 .1 .4 .1 .1 .3 .3 12.3 12.6 16.3 30 6 29.7-12.2 53.5l-1.9 2.2q-3 3.5-6.5 6.4-3.4 3.1-7.3 5.5-3.8 2.4-8.1 4.2-4.1 1.9-8.5 3.2-.3 0-.4 .2-.3 0-.4 .1-.1 .1-.3 .4 0 .1-.1 .3c-2.7 7.7-5.3 14.2-10.2 20.7-12.5 16.5-30.8 25.5-51.5 25.5q-24.6-.1-43.6-18.1-.2-.1-.4-.2-.2-.1-.4-.1-.2 0-.3 0-.3 0-.4 0c-5.4 1.7-10.9 1.9-16.7 1.9q-3.5 0-7-.5-3.4-.4-6.9-1.2-3.3-.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-.8-1.6-1.6-3.2-.6-1.7-1.3-3.3-.7-1.7-1.2-3.4-.5-1.6-1-3.4-1.1-4-1.6-7.9-.6-4-.6-8 0-4 .6-8 .4-4 1.4-8 0 0 0-.1 0-.1 0-.1 .2-.2 .2-.3 0-.1-.2-.1 0-.2 0-.3 0-.1-.1-.1 0-.2 0-.2-.1-.1-.1-.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-.8-2-1.3-4.1-.7-2-1.1-4-.4-2.1-.7-4.2-.2-2.2-.4-4.3-.2-2.8-.1-5.6 0-2.8 .3-5.4 .1-2.8 .6-5.6 .4-2.8 1.1-5.5 7-23.1 26.9-36.3 4.3-2.9 8.2-4.5 4.5-1.9 9-3.2 .2 0 .3-.1 .1-.2 .3-.3 .1 0 .1-.3 .1-.1 .1-.2 1-3.1 2.2-6 1-2.9 2.5-5.7 1.5-3 3.2-5.6 1.7-2.7 3.7-5.1 2.5-3.2 5.3-5.9 3-2.8 6.1-5.4 3.2-2.4 6.8-4.4 3.5-2 7.2-3.5zm48.3 146.4c-2.3 .1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3 .9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4 .1 4.8-.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-.5-4.5-.3-6.5 .9-2 1.1-3.5 3-4.1 5.2-.7 2.2-.4 4.6 .6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8 .7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7 .9 2.2-.5 4.2-1.9 5.4-3.9l20.1-34.1q.7-.9 .9-2.1 .3-1.1 .3-2.3 0-1.2-.3-2.2-.2-1.2-.8-2.2z" />
    </Mark>
  );
}

/** Codex cloud gradient stops, top to bottom, exactly as in the supplied SVG. */
export const CODEX_GRADIENT = ["#b1a7ff", "#7a9dff", "#3941ff"] as const;

/** Cursor: BB plugins/provider-acp/icons/cursor.svg (Cursor cube). */
function CursorMark({ className }: { className?: string }) {
  return (
    <Mark className={className} viewBox="0 0 24 24" color={markColor("--bbp-brand-cursor", "--foreground")}>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </Mark>
  );
}

/** Grok Build: BB plugins/provider-acp/icons/grok.svg (xAI mark). */
function GrokMark({ className }: { className?: string }) {
  return (
    <Mark className={className} viewBox="0.36 0.5 33.33 32" color={markColor("--bbp-brand-grok", "--foreground")}>
      <path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436" />
      <path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341" />
    </Mark>
  );
}

/** opencode: BB plugins/provider-acp/icons/opencode.svg (nested squares). */
function OpencodeMark({ className }: { className?: string }) {
  return (
    <Mark className={className} viewBox="-72 -42 384 384" color={markColor("--bbp-brand-opencode", "--foreground")}>
      <path d="M180 240H60V120H180V240Z" fillOpacity="0.45" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" />
    </Mark>
  );
}

/** Devin: plugins/devin/assets/devin.svg (Devin knot). */
function DevinMark({ className }: { className?: string }) {
  return (
    <Mark className={className} viewBox="0 0 192 192" color={markColor("--bbp-brand-devin", "--foreground")}>
      <path d="M62 22 93 40V61Q94 79 111 67L130 61 162 80V115L131 133 112 122Q96 113 93 134V153L62 171 31 153V117L62 99 78 108Q97 117 99 97 99 78 80 83L62 93 31 75V40Z" />
    </Mark>
  );
}

/**
 * Agent providers configured on this install, by BB provider id: BB 0.43.1's
 * bundled claude-code, codex and acp-cursor, the ACP presets acp-grok and
 * acp-opencode (`server/dist/builtin-plugins/provider-acp`), and our Devin
 * plugin (`acp-devin`). BB's `pi` already ships a tinted mask, and the
 * acp-hermes-agent / acp-omp presets are not configured here, so those keep
 * BB's artwork. Registering an id that is not configured would be harmless:
 * the host only looks a mark up when it draws that provider.
 */
export const PROVIDER_MARKS: readonly ProviderMark[] = [
  { providerId: "claude-code", label: "Claude Code", token: "--bbp-brand-claude", fallback: "--warning-text", paint: "token", source: "BB plugins/provider-claude-code/icons/claude-code.svg (Anthropic spark)", icon: ClaudeCodeMark },
  { providerId: "codex", label: "Codex", token: "--bbp-brand-codex", fallback: "--timeline-accent", paint: "artwork", source: "OpenAI Codex app icon, SVG supplied by Erwin (Codex cloud with the prompt)", icon: CodexMark },
  { providerId: "acp-cursor", label: "Cursor", token: "--bbp-brand-cursor", fallback: "--foreground", paint: "token", source: "BB plugins/provider-acp/icons/cursor.svg (Cursor cube)", icon: CursorMark },
  { providerId: "acp-grok", label: "Grok Build", token: "--bbp-brand-grok", fallback: "--foreground", paint: "token", source: "BB plugins/provider-acp/icons/grok.svg (xAI mark)", icon: GrokMark },
  { providerId: "acp-opencode", label: "opencode", token: "--bbp-brand-opencode", fallback: "--foreground", paint: "token", source: "BB plugins/provider-acp/icons/opencode.svg (nested squares)", icon: OpencodeMark },
  { providerId: "acp-devin", label: "Devin", token: "--bbp-brand-devin", fallback: "--foreground", paint: "token", source: "plugins/devin/assets/devin.svg (Devin knot)", icon: DevinMark },
];
