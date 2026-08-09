import { initLogger } from "evlog";

// Tests must not depend on a developer's .env. These are set before @keel/env
// imports dotenv, and dotenv never overwrites an already-present variable, so
// the values below win in every environment including CI.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
	"postgresql://postgres:password@localhost:5433/keel_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.CORS_ORIGIN ??= "http://localhost:3001";

// No terminal output and no .evlog/logs writes during a test run. The pipeline
// stays enabled on purpose: handlers read c.get("log"), so `enabled: false`
// would make every request 500. Tests that assert on wide events re-initialise
// with their own drain.
initLogger({ drain: () => Promise.resolve(), silent: true });
