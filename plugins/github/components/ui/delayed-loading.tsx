import { useEffect, useState, type ReactNode } from "react";

/** Render children only after a short delay, so fast loads never flash a skeleton. */
export function DelayedLoading({ children, delayMs = 150 }: { children: ReactNode; delayMs?: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return show ? <>{children}</> : null;
}
