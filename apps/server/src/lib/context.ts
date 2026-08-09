import type { EvlogVariables } from "evlog/hono";

/**
 * The Hono environment every route in this app is typed against.
 *
 * `actorId` is populated by `requireUser`, so it is only truthfully present on
 * routes that sit behind it. It is declared non-optional because a route that
 * reads it without the guard is a wiring mistake, not a runtime branch — the
 * guard either ran and there is an actor, or it returned 401 and the handler was
 * never reached.
 */
export interface AppEnv {
	Variables: EvlogVariables["Variables"] & {
		actorId: string;
	};
}
