import { fileURLToPath } from "node:url";

import { runMigrations } from "@keel/db/migrate";

/**
 * Deploy-time entrypoint: `bun dist/migrate.mjs`.
 *
 * Built alongside the server so the production image can migrate without carrying
 * `drizzle-kit`, the TypeScript schema or `drizzle.config.ts`. In the repository use
 * `bun run db:migrate` instead — that path has the toolchain and can also generate.
 *
 * The folder is resolved from this module's own URL, so it is correct wherever the
 * artifact is copied, and the Dockerfile puts the `.sql` files at `dist/migrations`.
 * An absent folder makes `migrate` throw rather than quietly apply nothing.
 */
const migrationsFolder = fileURLToPath(
	new URL("./migrations", import.meta.url)
);

await runMigrations(migrationsFolder);

process.stdout.write(`[migrate] applied migrations from ${migrationsFolder}\n`);
