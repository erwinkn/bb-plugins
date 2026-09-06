import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-options",
    mount() {
      // BB 0.42 owns this built-in row and has no menu visibility option.
      const style = document.createElement("style");
      style.dataset.automationsSidebar = "";
      style.textContent = `
        [data-sidebar-navigation-item="__bb__/automations"] > .bb-sidebar-hover-actions {
          display: none !important;
        }
      `;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
