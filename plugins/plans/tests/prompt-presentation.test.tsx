// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { mountPromptPresentation, promptPresentationCss } from "../lib/prompt-presentation";

afterEach(() => { document.body.replaceChildren(); document.head.querySelectorAll("[data-plans-prompt-presentation]").forEach(el => el.remove()); });

it("targets only Plans review provenance and cleans up on abort or reload", () => {
  // DOM contract from BB 0.43.1's plugin request renderer / shared shell.
  const card = (kind: string) => `<div data-testid="plugin-request-banner" data-request-kind="${kind}">
    <section data-testid="plugin-interaction-shell"><div><button><span title="Scheduling">Scheduling</span></button><a title="Source thread">From Source thread</a><button>Hide details</button></div>
    <div id="body-${kind}"><div><p><span class="capitalize">plans</span></p><fieldset><p>Keep schedules after restart.</p><button>Open review</button></fieldset></div></div></section></div>`;
  document.body.innerHTML = card("plans/plan-review") + card("questions/questions") + card("plans/other");
  const controller = new AbortController();
  const dispose = mountPromptPresentation({ signal: controller.signal });
  const style = document.head.querySelector<HTMLStyleElement>("[data-plans-prompt-presentation]")!;
  expect(style.textContent).toBe(promptPresentationCss);
  const hiddenSelector = promptPresentationCss.slice(0, promptPresentationCss.indexOf("{")).trim();
  const matches = [...document.querySelectorAll(hiddenSelector)];
  expect(matches.map(el => el.tagName)).toEqual(["A", "P"]);
  expect(matches.every(el => el.closest('[data-request-kind="plans/plan-review"]'))).toBe(true);
  expect(matches.some(el => el.closest("fieldset"))).toBe(false);
  controller.abort();
  expect(style.isConnected).toBe(false);
  dispose();
  const next = mountPromptPresentation({ signal: new AbortController().signal });
  expect(document.head.querySelectorAll("[data-plans-prompt-presentation]")).toHaveLength(1);
  next();
  expect(document.head.querySelectorAll("[data-plans-prompt-presentation]")).toHaveLength(0);
});
