import { afterEach, beforeEach } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { resetQueryClient } from "../lib/query";

// Query updates reach React in a microtask instead of the next macrotask, so
// the `act` around a realtime signal or an answer covers them.
notifyManager.setScheduler(queueMicrotask);

// Each test starts as a fresh page load: its first mount restores the query
// cache from whatever the test stored.
beforeEach(resetQueryClient);
afterEach(resetQueryClient);
