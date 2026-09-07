import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Jumps to a line. `12` goes to the start of line 12; `12:5` puts the caret on
 * its fifth character. Lines are counted from one, as they are in the gutter.
 */
export function GoToLine({
  lineCount,
  onGo,
  onClose,
}: {
  lineCount: number;
  onGo: (line: number, character: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const target = parseTarget(value, lineCount);
  const submit = () => {
    if (target === null) return;
    onGo(target.line, target.character);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center bg-background/40 pt-[6vh] backdrop-blur-[1px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Go to line"
        className="h-fit w-[min(360px,92%)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={value}
          placeholder={`Line number, 1 to ${lineCount}`}
          aria-label="Line number"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className="w-full bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <p
          className={cn(
            "border-t border-border px-3 py-1.5 text-xs",
            value !== "" && target === null ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {value === ""
            ? "Type a line number, or line:character"
            : target === null
              ? `This file has ${lineCount} lines`
              : `Go to line ${target.line}${target.character > 0 ? `, character ${target.character + 1}` : ""}`}
        </p>
      </div>
    </div>
  );
}

/** `12` or `12:5`, inside the file. Anything else has no target. */
export function parseTarget(value: string, lineCount: number): { line: number; character: number } | null {
  const match = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(value);
  if (match === null) return null;
  const line = Number(match[1]);
  if (!Number.isInteger(line) || line < 1 || line > Math.max(lineCount, 1)) return null;
  const column = match[2] === undefined ? 1 : Number(match[2]);
  return { line, character: Math.max(column - 1, 0) };
}
