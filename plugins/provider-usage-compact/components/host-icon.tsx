import type { CSSProperties } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { HostIconName } from "../lib/host-icon-names";

// JSX treats lowercase tags as intrinsic elements, so alias the SDK component.
const HostIcon = experimental_Icon;

export interface IconProps {
  /** A built-in host icon name from `lib/host-icon-names.ts`. */
  name: HostIconName;
  /** Rendered when the running host lacks `name`. Defaults to the host's Zap. */
  fallback?: HostIconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

/**
 * Renders a host icon through BB's registry. The name union is generated from
 * bb source so a typo fails at compile time instead of falling back at runtime.
 */
export function Icon({ fallback = "Zap", ...props }: IconProps) {
  return <HostIcon fallback={fallback} {...props} />;
}
