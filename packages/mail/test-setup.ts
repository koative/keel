// The queue suite talks to a real Postgres, so it needs the same bootstrap
// apps/server's preload performs: a DATABASE_URL that cannot be the developer's
// dev database, and enough of @keel/env to let it validate without a .env file.
//
// Duplicated rather than imported from `apps/server/test-setup` because a
// package cannot import app code — the same rule that moved `enqueue` into
// @keel/db. Only the values a mail job needs are set here; there is no logger,
// because nothing in this package emits one.
process.env.DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgresql://postgres:password@localhost:5433/keel_test";

process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.CORS_ORIGIN ??= "http://localhost:3001";
