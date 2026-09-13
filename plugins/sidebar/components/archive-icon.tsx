import { HostIcon } from "../lib/host-icon";

export function ArchiveIcon() {
  return (
    <HostIcon
      name="Archive"
      fallback="PackageReceive"
      className="size-4 shrink-0 text-[var(--subtle-foreground)]"
    />
  );
}
