import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({
	path: "../../apps/server/.env",
	quiet: true,
});

// drizzle-kit runs before the app exists, so it cannot go through @keel/env —
// importing that schema here would make generating a migration depend on every
// runtime key. It reads the one variable it needs, and refuses to invent it: the
// `|| ""` this replaces turned a missing value into a connection attempt against
// an empty URL, which surfaces as a socket error naming neither the variable nor
// this file.
const url = process.env.DATABASE_URL;

if (!url) {
	throw new Error(
		"DATABASE_URL is required by drizzle-kit. Set it in apps/server/.env, or pass it inline: DATABASE_URL=… bun run db:migrate."
	);
}

export default defineConfig({
	dbCredentials: { url },
	dialect: "postgresql",
	out: "./src/migrations",
	schema: "./src/schema",
});
