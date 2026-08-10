import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({
	path: "../../apps/server/.env",
	quiet: true,
});

/**
 * Read when drizzle-kit connects, and only then.
 *
 * A getter rather than a plain string, because drizzle-kit's commands do not all
 * need a database: `generate` diffs the schema against `./src/migrations` offline,
 * which is how `tools/check-migrations.ts` runs in CI — where no `apps/server/.env`
 * exists. Evaluating this eagerly made that check fail on a variable the command it
 * runs never uses, and the `url: process.env.DATABASE_URL || ""` it replaced was
 * quietly doing the same job: absent credentials that `generate` never looks at.
 *
 * So the difference between them is not laziness, it is what `push`, `migrate` and
 * `studio` get. `""` reached drizzle-kit as a credential and came back as `Either
 * connection "url" or "host", "database" are required`, naming neither the variable
 * nor the file that holds it. This names both.
 *
 * drizzle-kit runs before the app exists, so none of this can go through @keel/env:
 * importing that schema here would make generating a migration depend on every
 * runtime key.
 */
const dbCredentials = {
	get url(): string {
		const url = process.env.DATABASE_URL;

		if (!url) {
			throw new Error(
				"DATABASE_URL is required by drizzle-kit. Set it in apps/server/.env, or pass it inline: DATABASE_URL=… bun run db:migrate."
			);
		}

		return url;
	},
};

export default defineConfig({
	dbCredentials,
	dialect: "postgresql",
	out: "./src/migrations",
	schema: "./src/schema",
});
