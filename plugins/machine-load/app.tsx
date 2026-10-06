import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { createGaugeIcon } from "./components/gauge-icon";
import { createLoadPanel } from "./components/load-panel";
import { createLoadStore } from "./lib/load-store.js";

/** The footer button's icon is this live gauge, registered as an app icon. */
const GAUGE_ICON = "machine-load:gauge";

const store = createLoadStore();

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: GAUGE_ICON, component: createGaugeIcon(store) });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "load",
    label: "Machine load",
    icon: GAUGE_ICON,
    component: createLoadPanel(store),
  });
  app.contentScripts.register({
    id: "poll-load",
    mount({ signal }) {
      // Read only while this window is visible; a hidden tab costs nothing.
      let polling: AbortController | null = null;
      const sync = () => {
        const visible = document.visibilityState === "visible" && !signal.aborted;
        if (visible && polling === null) {
          polling = new AbortController();
          void store.run(polling.signal);
        } else if (!visible && polling !== null) {
          polling.abort();
          polling = null;
        }
      };
      document.addEventListener("visibilitychange", sync);
      sync();
      return () => {
        document.removeEventListener("visibilitychange", sync);
        polling?.abort();
        polling = null;
      };
    },
  });
});
