import { config } from "dotenv";
import { initLogger } from "evlog";

// The test environment is one committed file at the repository root. @keel/env
// validates its whole schema on import and every suite here imports it
// transitively, so a run needs every required key — and no key in that schema has
// a default to fall back on. `packages/mail/test-setup.ts` reads the same file, so
// the two cannot drift the first time a key is added.
//
// Deliberately not `override: true`: a value already in the environment is CI or a
// developer asking for something specific, and dotenv leaves those alone.
config({ path: new URL("../../.env.test", import.meta.url), quiet: true });

// Bun loads apps/server/.env before this preload runs, so `??=` would leave
// DATABASE_URL pointing at the developer's dev database — and an integration test
// that inserts and deletes rows would do it there. The test database is therefore
// assigned unconditionally, and from a variable with no fallback of its own: a URL
// invented here is a URL that can quietly be the wrong database.
if (!process.env.TEST_DATABASE_URL) {
	throw new Error(
		"TEST_DATABASE_URL is required to run the tests. It ships in .env.test at the repository root — restore it, or export the variable. Start the database with `bun run db:test:start && bun run db:test:migrate`."
	);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// The harness stating what it is, not a setting: better-auth disables its own rate
// limiter on `test`, and a run that inherited `development` from apps/server/.env
// would exercise a different code path than CI.
process.env.NODE_ENV = "test";

// No terminal output and no .evlog/logs writes during a test run. The pipeline
// stays enabled on purpose: handlers read c.get("log"), so `enabled: false`
// would make every request 500. Tests that assert on wide events re-initialise
// with their own drain.
initLogger({ drain: () => Promise.resolve(), silent: true });
