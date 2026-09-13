import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

// BB 0.43.1's plugin request renderer and shared interaction shell expose these
// DOM markers. Scope every rule to this renderer, including when it is shown
// in a parent thread. Unknown future host markup simply keeps its attribution.
const shell = '[data-testid="plugin-request-banner"][data-request-kind="plans/plan-review"] > [data-testid="plugin-interaction-shell"]';
export const promptPresentationCss = `
${shell} > div:first-child > a[title],
${shell} > div[id] > div > p:first-child:has(> span.capitalize) {
  display: none;
}
${shell} > div:first-child > button:first-child span[title] {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

/** Host DOM styling belongs to a disposable content script, not a global theme. */
export function mountPromptPresentation({ signal }: Pick<PluginContentScriptContext, "signal">) {
  const style = document.createElement("style");
  style.dataset.plansPromptPresentation = "";
  style.textContent = promptPresentationCss;
  const dispose = () => { style.remove(); signal.removeEventListener("abort", dispose); };
  document.head.append(style);
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  return dispose;
}
