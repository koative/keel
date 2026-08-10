import { config } from "dotenv";

/**
 * Prints the test database URL, for the `db:test:*` scripts to pass to drizzle-kit
 * as DATABASE_URL.
 *
 * It exists so the connection string lives in exactly one place. It used to be
 * spelled out in `package.json` beside a copy in each test preload, and three
 * copies of a URL are three chances for `bun run db:test:migrate` to migrate a
 * database the tests do not use — which presents as a suite failing on a column
 * that was added weeks ago.
 *
 * Turbo runs in strict env mode and only forwards the variables a task declares,
 * so exporting TEST_DATABASE_URL and letting drizzle-kit read it would not survive
 * the hop; the caller has to hand it over as DATABASE_URL.
 */
config({ path: new URL("../.env.test", import.meta.url), quiet: true });

const url = process.env.TEST_DATABASE_URL;

if (!url) {
	process.stderr.write(
		"TEST_DATABASE_URL is not set. It ships in .env.test at the repository root — restore it, or export the variable.\n"
	);
	process.exit(1);
}

process.stdout.write(url);
