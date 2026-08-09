import type { LogPort } from "@/lib/log";
import type {
	CreateProject,
	Project,
	ProjectContext,
	ProjectPage,
	ProjectStore,
} from "./projects.service";

/**
 * Test doubles for the service's two injected dependencies.
 *
 * This is the payoff of putting them in the signature: the store is an object
 * literal and the logger is four no-ops, so the service's tests need no
 * database, no HTTP server and no container.
 */

export const ACTOR = "actor-1";
export const ORGANIZATION = "org-1";
export const OTHER_ORGANIZATION = "org-2";

/**
 * A stored row, which carries the tenant the service's `Project` deliberately
 * does not. Seeding rows for two organizations is how the fake reproduces the
 * repository's WHERE clause, and therefore how a service test can still show
 * that another tenant's row is invisible rather than merely refused.
 */
export interface SeedProject extends Project {
	organizationId: string;
}

export const projectRow = (
	overrides: Partial<SeedProject> = {}
): SeedProject => ({
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	createdBy: ACTOR,
	description: null,
	id: "p1",
	name: "Billing",
	organizationId: ORGANIZATION,
	slug: "billing",
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

export interface StoreCalls {
	deleted: { id: string; organizationId: string }[];
	inserted: (CreateProject & {
		createdBy: string | null;
		organizationId: string;
	})[];
	listedFor: string[];
	pages: ProjectPage[];
}

export interface FakeStore {
	calls: StoreCalls;
	store: ProjectStore;
}

export interface FakeLog {
	fields: unknown[];
	log: LogPort;
}

export function fakeStore(seed: SeedProject[] = []): FakeStore {
	const calls: StoreCalls = {
		deleted: [],
		inserted: [],
		listedFor: [],
		pages: [],
	};

	return {
		calls,
		store: {
			deleteById(id, organizationId) {
				calls.deleted.push({ id, organizationId });
				return Promise.resolve();
			},
			findById(id, organizationId) {
				return Promise.resolve(
					seed.find(
						(item) => item.id === id && item.organizationId === organizationId
					)
				);
			},
			insert(input) {
				calls.inserted.push(input);
				return Promise.resolve(projectRow(input));
			},
			listByOrganization(organizationId, page) {
				calls.listedFor.push(organizationId);
				calls.pages.push(page);
				// Stands in for the real query: the organization's rows newest first,
				// seeking past the cursor, one more row than asked for so the service
				// can tell there is a further page.
				const after = page.cursor;
				return Promise.resolve(
					seed
						.filter((item) => item.organizationId === organizationId)
						.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
						.filter(
							(item) =>
								!after ||
								item.createdAt < after.createdAt ||
								(item.createdAt.getTime() === after.createdAt.getTime() &&
									item.id < after.id)
						)
						.slice(0, page.limit + 1)
				);
			},
		},
	};
}

export function fakeLog(): FakeLog {
	const fields: unknown[] = [];

	return {
		fields,
		log: {
			error: () => undefined,
			info: () => undefined,
			set: (context) => {
				fields.push(context);
			},
			warn: () => undefined,
		},
	};
}

/**
 * The context every service call takes, wired to the two fakes above.
 *
 * Shared so that each service test file states only the rows it seeds, and a
 * change to the context shape is one edit rather than one per test file.
 */
export const fakeContext = (
	store: FakeStore,
	log: FakeLog
): ProjectContext => ({
	actorId: ACTOR,
	log: log.log,
	organizationId: ORGANIZATION,
	repository: store.store,
});
