// Usage stats frontend: one page, routed at /plugins/usage-stats/usage.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH, UsagePage } from "./app/page";
import "./app.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: PANEL_PATH,
    component: UsagePage,
  });
});
