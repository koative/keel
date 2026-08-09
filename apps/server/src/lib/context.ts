import type { EvlogVariables } from "evlog/hono";

/**
 * The Hono environment every route in this app is typed against.
 *
 * `actorId` is populated by `requireUser`, so it is only truthfully present on
 * routes that sit behind it. It is declared non-optional because a route that
 * reads it without the guard is a wiring mistake, not a runtime branch — the
 * guard either ran and there is an actor, or it returned 401 and the handler was
 * never reached.
 *
 * `organizationId` is the same contract one guard further along: `requireOrg`
 * either ran and there is a tenant, or it returned 403. Every tenant-scoped
 * repository reads it as a plain string for that reason — making it optional
 * would push a `?? throw` into each of them and turn one guard into many.
 *
 * `activeOrganizationId` is the exception that proves the rule: it is populated
 * by `requireUser`, which does not require an organization, so `null` there is a
 * real state a route can meet — a signed-in user who has not joined one yet.
 * `requireOrg` is the only thing that reads it, and narrowing it is its whole
 * job.
 */
export interface AppEnv {
	Variables: EvlogVariables["Variables"] & {
		activeOrganizationId: string | null;
		actorId: string;
		organizationId: string;
	};
}
