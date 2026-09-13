import { createContext, useContext } from "react";
import type { ThreadDndRenderState } from "./use-thread-dnd";

export const ThreadDndContext = createContext<ThreadDndRenderState | null>(
  null,
);
export const useThreadDndState = () => useContext(ThreadDndContext);
