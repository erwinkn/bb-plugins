// Host icons by name. `name` is typed against bb's built-in icon registry at
// the pinned release (lib/host-icon-names.ts, regenerated on each bb
// upgrade), so a typo fails typecheck instead of silently falling back at
// runtime. `fallback` covers a running bb that lacks the name.
import type { CSSProperties } from "react";
import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { HostIconName } from "../../lib/host-icon-names";

export type IconName = HostIconName;

export interface IconProps {
  name: IconName;
  /** Rendered when the running bb does not know `name`. */
  fallback?: IconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({ name, fallback = "Circle", ...props }: IconProps) {
  return <HostIcon name={name} fallback={fallback} {...props} />;
}
