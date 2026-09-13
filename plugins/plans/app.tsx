// Plans — review agent plans as Markdown inside BB.
//
// Thread panel and header button; the backend contract lives in contract.ts.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadPlanHeaderButton, REVIEW_ACTION_ID } from "./components/ThreadPlanHeaderButton";
import { ThreadPlanPanel } from "./components/ThreadPlanPanel";
import { PlanReviewPrompt } from "./components/PlanReviewPrompt";
import { PLUGIN_ICONS } from "./components/ui/plugin-icons";
import { mountPromptPresentation } from "./lib/prompt-presentation";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "review-prompt-presentation", mount: mountPromptPresentation });
  // Glyphs bb does not ship; everything else renders from the host registry.
  for (const icon of PLUGIN_ICONS) app.experimental_icons.register(icon);

  app.slots.threadPanelAction({
    id: REVIEW_ACTION_ID,
    title: "Plans",
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

  // Shown in place of the composer while an agent blocks on a review. The id
  // must match the "plan-review" renderer in server/session.ts.
  app.slots.pendingInteraction({
    id: "plan-review",
    component: PlanReviewPrompt,
  });
});
