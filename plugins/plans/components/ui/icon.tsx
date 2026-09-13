import type { CSSProperties } from "react";
import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { HostIconName } from "../../lib/host-icon-names";
import type { PluginIconName } from "./plugin-icons";

/**
 * Host icon registry. `name` is typed against the names bb ships (generated
 * into lib/host-icon-names.ts) plus the icons this plugin registers itself, so
 * a typo fails typecheck instead of silently falling back at runtime.
 */
export type IconName = HostIconName | PluginIconName;

export interface IconProps {
  name: IconName;
  /** Shown when the host has no icon for `name`, for example after a bb upgrade. */
  fallback?: HostIconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({ name, fallback = "Zap", ...rest }: IconProps) {
  return <HostIcon name={name} fallback={fallback} {...rest} />;
}
