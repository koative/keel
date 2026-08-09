import type { LogPort } from "@/lib/log";
import type { CreateProject, Project, ProjectStore } from "./projects.service";

/**
 * Test doubles for the service's two injected dependencies.
 *
 * This is the payoff of putting them in the signature: the store is an object
 * literal and the logger is four no-ops, so the service's tests need no
 * database, no HTTP server and no container.
 */

export const ACTOR = "actor-1";
export const OTHER_ACTOR = "actor-2";

export const projectRow = (overrides: Partial<Project> = {}): Project => ({
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	description: null,
	id: "p1",
	name: "Billing",
	ownerId: ACTOR,
	slug: "billing",
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	...overrides,
});

export interface StoreCalls {
	deleted: string[];
	inserted: (CreateProject & { ownerId: string })[];
	listedFor: string[];
}

export interface FakeStore {
	calls: StoreCalls;
	store: ProjectStore;
}

export interface FakeLog {
	fields: unknown[];
	log: LogPort;
}

export function fakeStore(seed: Project[] = []): FakeStore {
	const calls: StoreCalls = { deleted: [], inserted: [], listedFor: [] };

	return {
		calls,
		store: {
			deleteById(id) {
				calls.deleted.push(id);
				return Promise.resolve();
			},
			findById(id) {
				return Promise.resolve(seed.find((item) => item.id === id));
			},
			insert(input) {
				calls.inserted.push(input);
				return Promise.resolve(projectRow(input));
			},
			listByOwner(ownerId) {
				calls.listedFor.push(ownerId);
				return Promise.resolve(seed.filter((item) => item.ownerId === ownerId));
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
