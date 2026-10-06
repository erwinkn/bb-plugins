import { afterEach } from "vitest";
import { appReads } from "../lib/dashboard-data";

// The dashboard cache lives for the app session; each test starts empty.
afterEach(() => appReads.clear());
