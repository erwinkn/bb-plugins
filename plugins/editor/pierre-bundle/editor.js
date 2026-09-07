/**
 * The lazy Pierre bundle this plugin serves from `/http/pierre`.
 *
 * It exports Pierre's vanilla API only. There is no React here on purpose: the
 * plugin's app bundle already runs inside BB's React, and a second React copy
 * in a lazily imported module would give hooks from one runtime to components
 * of another. `components/PierreSurface.tsx` is the React wrapper, and it holds
 * no Pierre import except types.
 *
 * `container-owner.js` comes first because it must observe the custom-element
 * registry before the `@pierre/diffs` import registers `<diffs-container>`.
 */
import { containerExisted } from "./container-owner.js";
import { registerCustomTheme as registerPierreTheme } from "@pierre/diffs";

export {
  CodeView,
  diffAcceptRejectHunk,
  DIFFS_TAG_NAME,
  disposeHighlighter,
  getFiletypeFromFileName,
  getLineEndingType,
  parseDiffFromFile,
  preloadHighlighter,
  registerCustomLanguage,
  setLanguageOverride,
} from "@pierre/diffs";
export { Editor } from "@pierre/diffs/edit";
export { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";

// BB can reload the app module while this lazy runtime stays in the browser's
// module cache. Its theme registry must share that longer lifetime too. Theme
// names contain their content revision, so repeat names keep the first loader.
const registeredThemes = new Set();
export const registerCustomTheme = (name, loader) => {
  if (registeredThemes.has(name)) return;
  registerPierreTheme(name, loader);
  registeredThemes.add(name);
};

/**
 * False when BB (or any other copy of Pierre) defined `<diffs-container>`
 * first. The surface then draws into an element whose shadow root carries the
 * other copy's stylesheet. Rendering still works, but the styling is not this
 * version's, so the loader reports it and live testing must check it.
 */
export const ownsContainerElement = !containerExisted;

/** The exact version this bundle was built against. */
export const version = "1.4.1";

let fontPromise;
export const loadFont = () => {
  fontPromise ??= (async () => {
    const font = new FontFace("BB Editor Geist Mono", `url(${new URL("./geist-mono-5.3.0-latin.woff2", import.meta.url)})`, {
      weight: "100 900",
      style: "normal",
      display: "swap",
    });
    await font.load();
    document.fonts.add(font);
  })();
  return fontPromise;
};
