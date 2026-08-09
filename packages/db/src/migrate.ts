import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closePool, db } from "./index";

/**
 * Applies the committed migrations, then drains the pool.
 *
 * This exists so that applying migrations does not require `drizzle-kit`, which is
 * a devDependency. The deploy path is the one place that must run them, and it is
 * also the place with the least available tooling: a production image that carries
 * the whole toolchain, the TypeScript schema and `drizzle.config.ts` just to run a
 * handful of `ALTER TABLE`s is carrying a build system into production.
 *
 * `migrate` is part of `drizzle-orm`, already a runtime dependency, and reads the
 * same `_journal.json` and `.sql` files `drizzle-kit generate` writes. It records
 * what it applied in `drizzle.__drizzle_migrations`, so it is safe to run on every
 * boot and on every instance of a rolling deploy — the second one applies nothing.
 *
 * The folder is resolved by the caller rather than hardcoded, because the path
 * differs between the repository and a built image, and a wrong path here fails as
 * "0 migrations applied" — which looks exactly like success.
 */
export async function runMigrations(migrationsFolder: string): Promise<void> {
	try {
		await migrate(db, { migrationsFolder });
	} finally {
		await closePool();
	}
}
