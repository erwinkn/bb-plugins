import type { ComponentProps } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

declare const __BB_PLUGIN_ID__: string | undefined;

// The small-menu parts of BB's vendored Radix recipe. Keep the portal in BB's
// plugin styling scope while sharing the host's focus and dismissal layers.
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({ className = "", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      data-bb-portaled-overlay="" data-bb-plugin-root="" data-bb-plugin={pluginId}
      align="end" sideOffset={4} collisionPadding={8}
      className={`sp-export-menu ${className}`} {...props}
    />
  </DropdownMenuPrimitive.Portal>;
}

export function DropdownMenuItem({ className = "", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={`sp-menu-item ${className}`} {...props} />;
}
