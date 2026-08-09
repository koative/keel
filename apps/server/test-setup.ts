import { initLogger } from "evlog";

// Bun loads .env before this preload runs, so `??=` would leave DATABASE_URL
// pointing at the developer's dev database — and an integration test that
// inserts and deletes rows would do it there. The test database is therefore
// assigned unconditionally; TEST_DATABASE_URL is the only way to redirect it.
process.env.DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgresql://postgres:password@localhost:5433/keel_test";

// The rest only need to exist so @keel/env validates without a .env file.
process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.CORS_ORIGIN ??= "http://localhost:3001";

// No terminal output and no .evlog/logs writes during a test run. The pipeline
// stays enabled on purpose: handlers read c.get("log"), so `enabled: false`
// would make every request 500. Tests that assert on wide events re-initialise
// with their own drain.
initLogger({ drain: () => Promise.resolve(), silent: true });
