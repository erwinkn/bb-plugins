import React from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { HostIconName } from "./host-icon-names";

/**
 * A host registry icon typed against the names bb ships (lib/host-icon-names.ts,
 * generated per bb release). A misspelt name fails typecheck instead of quietly
 * rendering the host's Zap fallback; the fallback still covers a renamed icon
 * on an older host.
 */
export function HostIcon({ name, fallback = "Circle", className, label }: { name: HostIconName; fallback?: HostIconName; className?: string; label?: string }) {
  return <Icon name={name} fallback={fallback} className={className} aria-hidden={label ? undefined : true} aria-label={label} />;
}
