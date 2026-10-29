// MCP servers frontend: one section on the plugin's settings page
// (Settings → Plugins → MCP servers).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { withQueries } from "./lib/queries";
import { SettingsSection } from "./app/settings";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "servers",
    title: "Servers",
    component: withQueries(SettingsSection),
  });
});
