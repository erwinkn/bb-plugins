import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutCheatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Redline and Looks good save directly; they are offered only when the reviewer can annotate. */
  canAnnotate: boolean;
}

interface Shortcut {
  keys: string[];
  action: string;
}

/**
 * Whether the browser runs on an Apple platform, from `navigator.userAgentData`
 * with a user agent fallback. Returns null when neither source says.
 */
export function detectApplePlatform(nav: Pick<Navigator, "userAgent"> & { userAgentData?: { platform?: string } } | undefined): boolean | null {
  if (!nav) return null;
  const platform = nav.userAgentData?.platform;
  if (platform) return /^(mac|iOS|iPhone|iPad)/i.test(platform);
  const ua = nav.userAgent ?? "";
  if (/\b(Macintosh|iPhone|iPad|iPod)\b/.test(ua)) return true;
  if (/\b(Windows|Android|Linux|CrOS)\b/.test(ua)) return false;
  return null;
}

/** The submit key label for this platform; both forms when the platform is unknown. */
export function submitShortcutKeys(apple: boolean | null): string[] {
  if (apple === true) return ["⌘ Enter"];
  if (apple === false) return ["Ctrl Enter"];
  return ["⌘ Enter", "Ctrl Enter"];
}

export function selectionShortcuts(canAnnotate: boolean): Shortcut[] {
  return [
    { keys: ["C"], action: "Add a comment on the selection (opens the composer)" },
    { keys: ["A"], action: "Ask about the selection (opens the composer)" },
    ...(canAnnotate
      ? [
          { keys: ["D"], action: "Redline the selection (saves directly)" },
          { keys: ["G"], action: "Looks good for the selection (saves directly)" },
        ]
      : []),
    { keys: ["?"], action: "Open this cheat sheet" },
  ];
}

export function composerShortcuts(apple: boolean | null): Shortcut[] {
  return [
    { keys: submitShortcutKeys(apple), action: "Submit the text" },
    { keys: ["Esc"], action: "Cancel and close the composer" },
  ];
}

function Key({ label }: { label: string }) {
  return (
    <kbd className="inline-block rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs leading-none text-foreground">
      {label}
    </kbd>
  );
}

function ShortcutTable({ caption, shortcuts }: { caption: string; shortcuts: Shortcut[] }) {
  return (
    <table className="w-full text-sm">
      <caption className="mb-1.5 text-left text-xs text-muted-foreground">{caption}</caption>
      <tbody>
        {shortcuts.map((shortcut) => (
          <tr key={shortcut.action}>
            <th scope="row" className="w-24 whitespace-nowrap py-1 pr-3 text-left font-normal align-top">
              {shortcut.keys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? <span className="mx-1 text-muted-foreground">or</span> : null}
                  <Key label={key} />
                </span>
              ))}
            </th>
            <td className="py-1 align-top">{shortcut.action}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The review and composer shortcuts, reachable from the actions menu and the ? key. */
export function ShortcutCheatSheet({ open, onOpenChange, canAnnotate }: ShortcutCheatSheetProps) {
  const apple = detectApplePlatform(typeof navigator === "undefined" ? undefined : navigator);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Select text in the plan, then press a key. Composer keys apply while you type.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ShortcutTable caption="With text selected in the plan" shortcuts={selectionShortcuts(canAnnotate)} />
          <ShortcutTable caption="In the composer" shortcuts={composerShortcuts(apple)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
