import * as sdk from "@get-bb/plugin-sdk/app";

// Select the implementation once so hook order cannot change between renders.
// `in` also supports partial test-runtime module mocks with no sidebar export.
const hasSidebarThreads = "experimental_useSidebarThreads" in sdk &&
  typeof sdk.experimental_useSidebarThreads === "function";

function useSidebarLiveStatus(threadId: string | null): string | null {
  const state = sdk.experimental_useSidebarThreads();
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return null;
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "Waiting for you";
  if (["runtime", "background-agent", "working-draft"].includes(thread.indicator)) return "Agent is working";
  return null;
}

/** Older host and test runtimes may not provide the sidebar hook. */
export const useLiveStatus = hasSidebarThreads ? useSidebarLiveStatus : (_threadId: string | null): null => null;
