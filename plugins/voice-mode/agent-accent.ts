// Accent classes for the voice agent ("Ada") and for healthy status.
//
// BB's default palette makes `--primary` a neutral gray in dark mode, so it
// is not a color there. The agent purple comes from the theme plugin's
// `--bbp-agent` role token and falls back to BB's own `--pr-merged`, which
// every BB palette defines; both pairs clear 3:1 for glyphs and dots and
// 4.5:1 for the short "Ada" label. Tailwind arbitrary values keep the
// plugin bundle free of custom theme colors and literal oklch. The class
// strings must stay literal: the Tailwind scanner cannot see interpolation.

export const AGENT_TEXT_CLASS = "text-[var(--bbp-agent,var(--pr-merged))]";
export const AGENT_DOT_CLASS = "bg-[var(--bbp-agent,var(--pr-merged))]";
export const AGENT_AVATAR_CLASS =
  "bg-[color-mix(in_oklab,var(--bbp-agent,var(--pr-merged))_15%,transparent)] text-[var(--bbp-agent,var(--pr-merged))]";

/** Healthy / connected: the done green, BB's `--success` otherwise. */
export const DONE_DOT_CLASS = "bg-[var(--bbp-done,var(--success))]";
