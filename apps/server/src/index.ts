import { env } from "@keel/env/server";
import { initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";
import { app } from "./app";

// Process-wide and not idempotent: evlog's own docs warn that a second call
// without `drain` clears the drain for every copy of the package. This entry
// point is the only place allowed to call it.
initLogger({
	drain: env.NODE_ENV === "production" ? undefined : createFsDrain(),
	env: { service: "keel-server" },
});

// Exporting the fetch handler rather than re-exporting `app` keeps the runtime
// contract explicit: Bun reads `fetch` and resolves the port from PORT itself.
export default { fetch: app.fetch };
