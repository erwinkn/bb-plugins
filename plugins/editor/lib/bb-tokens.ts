/**
 * BB's surface colors, resolved to solid hex so Monaco can paint its chrome
 * (gutter, widgets, guides, scrollbars) with the same surfaces the rest of
 * the panel uses. BB defines its palette in oklch with alpha overlays, so the
 * values are composited over the app background on a canvas.
 */
export interface BbTokens {
  background: string;
  surfaceRaised: string;
  surfaceRecessed: string;
  popover: string;
  stateHover: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  subtleForeground: string;
  ring: string;
}

const CLASSES: Record<keyof BbTokens, { className: string; property: "backgroundColor" | "color" }> = {
  background: { className: "bg-background", property: "backgroundColor" },
  surfaceRaised: { className: "bg-surface-raised", property: "backgroundColor" },
  surfaceRecessed: { className: "bg-surface-recessed", property: "backgroundColor" },
  popover: { className: "bg-popover", property: "backgroundColor" },
  stateHover: { className: "bg-state-hover", property: "backgroundColor" },
  border: { className: "bg-border", property: "backgroundColor" },
  foreground: { className: "text-foreground", property: "color" },
  mutedForeground: { className: "text-muted-foreground", property: "color" },
  subtleForeground: { className: "text-subtle-foreground", property: "color" },
  ring: { className: "bg-ring", property: "backgroundColor" },
};

let canvas: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (canvas === undefined) {
    const element = document.createElement("canvas");
    element.width = 1;
    element.height = 1;
    canvas = element.getContext("2d", { willReadFrequently: true });
  }
  return canvas;
}

/** Composite `color` over `base` (both any CSS color) and return `#rrggbb`. */
export function compositeHex(base: string, color: string): string | null {
  const ctx = context();
  if (ctx === null) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Reads the tokens from live CSS. `host` should be inside the plugin's DOM so
 * the classes resolve under the same theme; the probes are removed at once.
 */
export function resolveBbTokens(host: HTMLElement): BbTokens | null {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  const raw: Partial<Record<keyof BbTokens, string>> = {};
  try {
    host.appendChild(probe);
    for (const [key, { className, property }] of Object.entries(CLASSES) as [keyof BbTokens, (typeof CLASSES)[keyof BbTokens]][]) {
      const element = document.createElement("div");
      element.className = className;
      probe.appendChild(element);
      raw[key] = getComputedStyle(element)[property];
    }
  } finally {
    probe.remove();
  }
  const background = raw.background;
  if (background === undefined || background === "" || background === "rgba(0, 0, 0, 0)") return null;
  const solidBackground = compositeHex("#000000", background);
  if (solidBackground === null) return null;
  const resolved: Partial<BbTokens> = { background: solidBackground };
  for (const key of Object.keys(CLASSES) as (keyof BbTokens)[]) {
    if (key === "background") continue;
    const value = raw[key];
    const hex = value === undefined || value === "" ? null : compositeHex(solidBackground, value);
    if (hex === null) return null;
    resolved[key] = hex;
  }
  return resolved as BbTokens;
}
