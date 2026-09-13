/** This plugin registers no icons of its own; every glyph comes from the host registry. */
export const PLUGIN_ICON_NAMES = [] as const;
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];
