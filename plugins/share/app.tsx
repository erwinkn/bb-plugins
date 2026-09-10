import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { HeaderControl } from "./components/share/HeaderControl";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "share",
    title: "Share",
    component: HeaderControl,
  });
});
