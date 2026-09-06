import type { ButtonHTMLAttributes } from "react";

// Reduced from the BB scaffold button; this fixture needs one native control.
export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="min-h-11 w-full cursor-pointer rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      {...props}
    />
  );
}
