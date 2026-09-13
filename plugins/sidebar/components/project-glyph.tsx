import { HostIcon } from "../lib/host-icon";
import { projectHueStep } from "../lib/project-hue";

/**
 * A folder glyph in the project's identity color (lib/project-hue.tsx).
 * Decorative: the project name always sits next to it. The personal
 * "No project" keeps a neutral glyph because it is not a real project.
 */
export function ProjectGlyph({
  name,
  neutral = false,
  className = "",
}: {
  name: string;
  neutral?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-project-glyph=""
      data-project-hue={neutral ? undefined : projectHueStep(name)}
      className={`flex shrink-0 items-center ${neutral ? "text-[var(--subtle-foreground)]" : ""} ${className}`}
    >
      <HostIcon name="Folder" fallback="Folder02" className="size-3.5" />
    </span>
  );
}
