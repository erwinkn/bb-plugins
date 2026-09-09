/// <reference types="node" />
// PREVIEW ONLY: runs the plugin UI in a browser outside BB.
//   npm run preview   →  http://localhost:5199
// SDK hooks resolve to ./sdk-app-shim.tsx; RPC calls hit ./rpc-backend.ts,
// which runs the real server.ts inside the SDK's fake plugin host.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL("./", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function previewBackend(): Plugin {
  return {
    name: "plans-preview-backend",
    async configureServer(server) {
      const backend = await server.ssrLoadModule(`${root}rpc-backend.ts`) as {
        handleRpc(method: string, input: unknown): Promise<unknown>;
        getPreviewMessages(): unknown[];
        getPreviewEvents(after: number): unknown;
        disposePreview(): Promise<void>;
      };
      server.httpServer?.once("close", () => {
        void backend.disposePreview();
      });
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (req.method === "GET" && url === "/preview/messages") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(backend.getPreviewMessages()));
          return;
        }
        if (req.method === "GET" && url.startsWith("/preview/events?")) {
          res.setHeader("content-type", "application/json");
          const after = Number(new URL(url, "http://preview").searchParams.get("after")) || 0;
          res.end(JSON.stringify(backend.getPreviewEvents(after)));
          return;
        }
        const match = url.match(/^\/preview\/rpc\/([A-Za-z0-9_]+)$/);
        if (!match || req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("content-type", "application/json");
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
            chunks.push(chunk as Buffer);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const input: unknown = raw ? JSON.parse(raw) : {};
          const result = await backend.handleRpc(match[1]!, input);
          res.end(JSON.stringify(result ?? null));
        } catch (cause) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
        }
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), previewBackend()],
  resolve: {
    alias: [
      { find: "@get-bb/plugin-sdk/app", replacement: `${root}sdk-app-shim.tsx` },
      { find: "@", replacement: pluginRoot.replace(/\/$/, "") },
    ],
  },
  server: {
    port: 5199,
    strictPort: true,
    // Remote preview through bb connect.
    allowedHosts: ["erwin--5199.getbb.app"],
  },
});
