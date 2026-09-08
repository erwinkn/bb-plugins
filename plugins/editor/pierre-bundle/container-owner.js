/**
 * Records whether `<diffs-container>` already existed before this bundle
 * imported Pierre.
 *
 * `@pierre/diffs` defines that custom element as a side effect, but only when
 * no other copy defined it first. BB's app registers the same tag from its own
 * Pierre copy, which can be a different version. Whichever copy runs first owns
 * the element and its shadow-root stylesheet, so the loser renders its DOM
 * inside the winner's CSS.
 *
 * This module must be imported before `@pierre/diffs` so the check runs before
 * that side effect. ES modules evaluate imports in declaration order, so the
 * import order in `editor.js` is what keeps this correct.
 */
export const containerExisted =
  typeof customElements !== "undefined" && customElements.get("diffs-container") !== undefined;
