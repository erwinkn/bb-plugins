import { definePluginApp } from "@get-bb/plugin-sdk/app";

// BB 0.42 owns the plugin-nav ellipsis (Hide / Customize) and has no
// per-row visibility option. The attribute is only on plugin nav rows,
// including Automations remapped to __bb__/automations. Thread rows and
// built-in New thread / Search / Extensions use different markup.
const PLUGIN_NAV_MENU_STYLE = `
  [data-sidebar-navigation-item] > .bb-sidebar-hover-actions {
    display: none !important;
  }
  [data-sidebar-navigation-item] > [data-plugin-nav-sidebar-accessory] {
    opacity: 1 !important;
  }
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "sidebar-options",
    mount() {
      const style = document.createElement("style");
      style.dataset.hidePluginNav = "";
      style.textContent = PLUGIN_NAV_MENU_STYLE;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
