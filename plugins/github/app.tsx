// GitHub — issues and pull requests in BB, pull requests linked to threads,
// and PR links that open in a side panel instead of the browser.
//
// Registrations:
// - navPanel "github": the upstream Issues / Pull requests browser.
// - threadPanelAction "pull": the thread's linked PRs and a read-only viewer.
//   `params: { url }` opens one PR straight away (that is what the link
//   interception and the header action pass).
// - experimental_threadHeaderAction "pull-requests": per-pane bridge that can
//   open the panel, plus a PR count button.
// - experimental_appOverlay "open-pull-request": fallback router for requests
//   no pane took (navigate to the thread, or open the URL externally).
// - contentScripts "pull-request-links": the click interception.
// The request path between them is documented in lib/open-pull-request.ts.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { GithubPanel, PANEL_PATH, PanelHeader } from "./components/github-panel";
import { OpenPullRequestOverlay } from "./components/open-pull-request-overlay";
import { PullRequestHeaderAction } from "./components/pull-request-header-action";
import { PULL_LIST_PANEL_TITLE, PULL_PANEL_ACTION_ID, PullRequestsPanel } from "./components/pull-requests-panel";
import { mountLinkInterception } from "./lib/link-interception";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "pull-request-links", mount: (context) => mountLinkInterception(context) });

  app.slots.navPanel({
    id: "github",
    title: "GitHub",
    icon: "Github",
    path: PANEL_PATH,
    component: GithubPanel,
    headerContent: PanelHeader,
  });

  app.slots.threadPanelAction({
    id: PULL_PANEL_ACTION_ID,
    title: PULL_LIST_PANEL_TITLE,
    icon: "Github",
    component: PullRequestsPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "pull-requests",
    title: "Pull requests",
    component: PullRequestHeaderAction,
  });

  app.slots.experimental_appOverlay({
    id: "open-pull-request",
    component: OpenPullRequestOverlay,
  });
});
