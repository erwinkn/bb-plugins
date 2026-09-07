// Questions plugin frontend: the Notebook side panel, a thread header
// control, and the `::questions{round="…"}` message directive.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DIRECTIVE_NAME } from "./lib/model";
import { NotebookPanel } from "./components/notebook/NotebookPanel";
import { HeaderControl } from "./components/notebook/HeaderControl";
import { NOTEBOOK_ACTION_ID, QuestionsDirective } from "./components/notebook/InlineRound";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: NOTEBOOK_ACTION_ID,
    title: "Questions",
    icon: "MessageQuestion",
    layout: "flush",
    component: NotebookPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "questions",
    title: "Questions",
    component: HeaderControl,
  });
  app.slots.messageDirective({
    id: DIRECTIVE_NAME,
    component: QuestionsDirective,
  });
});
