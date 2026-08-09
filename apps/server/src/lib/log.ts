import type { RequestLogger } from "evlog";

/**
 * The slice of the request logger a service is allowed to touch.
 *
 * A service cannot import `hono`, so it cannot reach `c.get("log")` — the logger
 * arrives as a parameter instead. Narrowing it here is what makes that cheap:
 * evlog's `AuditableLogger` has eight members, one of which is a callable object
 * with a `.deny` property, so faking the whole thing in every service test would
 * cost more than the test. A real logger satisfies this structurally, and a fake
 * is four no-ops.
 *
 * `audit` is deliberately absent: audit trails are a route-level concern, and a
 * service that wants one is a service that has grown an HTTP opinion.
 */
export type LogPort = Pick<RequestLogger, "set" | "info" | "warn" | "error">;
