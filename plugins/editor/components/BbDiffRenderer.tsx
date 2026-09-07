import { useState } from "react";
import { useSettings, type PluginDiffRendererProps } from "@get-bb/plugin-sdk/app";
import { lineHeightFor, monoFontFamily, prefsFrom } from "@/lib/editor-options";
import { usePierreTheme } from "@/lib/pierre-theme";
import { useAssets } from "@/lib/use-assets";
import { patchRowEstimate } from "@/lib/bb-diff";
import { PierreDiffBlock } from "./PierreDiffBlock";

/**
 * BB's diff renderer, replaced: every diff BB draws from a patch comes
 * through here, and gets the same viewer as the Changes tab. The "Draw BB's
 * diffs" setting hands the request back to BB, as does any failure to draw.
 */
export function BbDiffRenderer(props: PluginDiffRendererProps) {
  const { Original } = props;
  const { values } = useSettings();
  const prefs = prefsFrom(values as Record<string, unknown> | null | undefined);
  const theme = usePierreTheme();
  const assets = useAssets();
  const [failed, setFailed] = useState<string | null>(null);

  if (!prefs.bbDiffs || failed !== null || assets.kind === "error") return <Original />;
  const lineHeight = lineHeightFor(prefs.fontSize);
  if (assets.kind === "loading") {
    return <div aria-busy="true" style={{ minHeight: patchRowEstimate(props.patch) * lineHeight }} />;
  }
  const full = props.experimental_fullFileContents;
  return (
    <PierreDiffBlock
      baseUrl={assets.baseUrl}
      patch={props.patch}
      sides={full === null ? null : { old: { path: full.old.path, content: full.old.content }, new: { path: full.new.path, content: full.new.content } }}
      view={props.view}
      wrap={props.overflow === "wrap"}
      lineNumbers={props.showLineNumbers}
      fontSize={prefs.fontSize}
      lineHeight={lineHeight}
      fontFamily={monoFontFamily()}
      theme={theme}
      onStatusChange={(status) => {
        if (status.kind === "error") {
          console.warn("[erwin-editor] falling back to BB's diff renderer:", status.message);
          setFailed(status.message);
        }
      }}
    />
  );
}
