// Match bb's host-bundle createRequire banner for the SDK's CJS dependencies.
import { createRequire } from "node:module";
globalThis.require = createRequire(import.meta.url);
