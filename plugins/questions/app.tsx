// Questions plugin frontend: the Questions side panel, a thread header
// control, and the `::questions{round="…"}` message directive.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DIRECTIVE_NAME } from "./lib/model";
import { QuestionsPanel } from "./components/questions/QuestionsPanel";
import { HeaderControl } from "./components/questions/HeaderControl";
import { QUESTIONS_ACTION_ID, QuestionsDirective } from "./components/questions/InlineRound";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: QUESTIONS_ACTION_ID,
    title: "Questions",
    icon: "MessageQuestion",
    layout: "flush",
    component: QuestionsPanel,
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
