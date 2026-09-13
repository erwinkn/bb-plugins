/**
 * Icons this plugin adds to the host registry in app.tsx. Names are
 * namespaced so they never shadow a bb built-in. Only glyphs bb does not
 * ship belong here.
 */
export const PLUGIN_ICON_NAMES = ["plans-keyboard", "plans-strikethrough"] as const;
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

function KeyboardGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01M8 16h8" />
    </svg>
  );
}

function StrikethroughGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h16" />
      <path d="M17 7.5c-.6-2-2.6-3-5-3-3 0-5 1.5-5 3.5 0 1.6 1 2.6 3 3.2" />
      <path d="M7 16.5c.6 2 2.6 3 5 3 3 0 5-1.5 5-3.5 0-.6-.1-1.1-.4-1.5" />
    </svg>
  );
}

export const PLUGIN_ICONS: ReadonlyArray<{ name: PluginIconName; component: typeof KeyboardGlyph }> = [
  { name: "plans-keyboard", component: KeyboardGlyph },
  { name: "plans-strikethrough", component: StrikethroughGlyph },
];
