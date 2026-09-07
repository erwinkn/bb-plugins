// Plans — review agent plans as Markdown inside BB.
//
// Thread panel and header button; the backend contract lives in contract.ts.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadPlanHeaderButton, REVIEW_ACTION_ID } from "./components/ThreadPlanHeaderButton";
import { ThreadPlanPanel } from "./components/ThreadPlanPanel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: REVIEW_ACTION_ID,
    title: "Review plan",
    icon: "ListTodo",
    layout: "flush",
    component: ThreadPlanPanel,
    run: ({ threadId, openPanel }) => {
      openPanel({ title: "Plan", params: { threadId } });
    },
  });

  app.slots.experimental_threadHeaderAction({
    id: "plan-status",
    title: "Plan",
    component: ThreadPlanHeaderButton,
  });
});
