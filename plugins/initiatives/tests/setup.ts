import { afterEach } from "vitest";
import { appReads } from "../lib/dashboard-data";
import { forgetUnconfirmedWrites } from "../lib/write-timeout";

// The dashboard cache lives for the app session; each test starts empty.
afterEach(() => appReads.clear());
// Remembered UI choices (the open tab, the PRs view) would leak from one test into the next.
afterEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });
// Unconfirmed writes' keys kept in memory where there is no localStorage (W248).
afterEach(() => forgetUnconfirmedWrites());
