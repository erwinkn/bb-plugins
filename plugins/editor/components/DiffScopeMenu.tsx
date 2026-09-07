import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { CheckIcon } from "./icons";

type Decoration = { id?: string; icon?: ReactNode; title?: string; shortcut?: string };
export type ScopeMenuItem =
  | (Decoration & { type?: "item"; label: string; onSelect: () => void; disabled?: boolean; keepOpen?: boolean })
  | (Decoration & { type: "radio"; label: string; checked: boolean; onToggle: (next: boolean) => void })
  | { type: "separator" }
  | { type: "label"; label: string };

/** BB's dropdown becomes a drawer on compact screens and shares its overlay scope. */
export function DiffScopeMenu({ children, items, open, onOpenChange }: {
  children: ReactElement;
  items: ScopeMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Compare changes"
        className="w-[340px] max-w-[calc(100vw-16px)] max-h-[min(720px,calc(100dvh-32px))] overflow-y-auto"
      >
        {items.map((item, index) => {
          if (item.type === "separator") return <DropdownMenuSeparator key={`separator-${index}`} />;
          if (item.type === "label") return <DropdownMenuLabel key={`label-${index}`} className="truncate text-[10px] font-normal text-muted-foreground" title={item.label}>{item.label}</DropdownMenuLabel>;
          const radio = item.type === "radio";
          return (
            <DropdownMenuItem
              key={item.id ?? item.label}
              role={radio ? "menuitemradio" : "menuitem"}
              aria-checked={radio ? item.checked : undefined}
              disabled={!radio && item.disabled}
              title={item.title}
              textValue={item.label}
              onSelect={(event) => {
                if (radio) item.onToggle(!item.checked);
                else { if (item.keepOpen) event.preventDefault(); item.onSelect(); }
              }}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut ? <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.shortcut}</span> : null}
              {radio ? <span className="flex size-3.5 shrink-0 items-center justify-center">{item.checked ? <CheckIcon /> : null}</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
