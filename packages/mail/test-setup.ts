import { config } from "dotenv";

// The queue suite talks to a real Postgres, so it needs the same bootstrap
// apps/server's preload performs: the test environment, and a DATABASE_URL that
// cannot be the developer's dev database.
//
// The values themselves are no longer duplicated — both preloads read `.env.test`
// at the repository root. That file is where they can be shared: a package may not
// import from apps/, the same rule that moved `enqueue` into @keel/db. There is no
// logger here, because nothing in this package emits one.
config({ path: new URL("../../.env.test", import.meta.url), quiet: true });

if (!process.env.TEST_DATABASE_URL) {
	throw new Error(
		"TEST_DATABASE_URL is required to run the tests. It ships in .env.test at the repository root — restore it, or export the variable. Start the database with `bun run db:test:start && bun run db:test:migrate`."
	);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
