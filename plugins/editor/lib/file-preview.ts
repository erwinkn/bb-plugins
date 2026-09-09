import { splitPath } from "./file-tree";

export function previewKind(path: string): "markdown" | "html" | null {
  const { name } = splitPath(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  switch (name.slice(dot + 1).toLowerCase()) {
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    default:
      return null;
  }
}
