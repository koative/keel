import { afterEach, describe, expect, it } from "bun:test";
import { type DrainContext, initLogger } from "evlog";
import { app } from "./app";

const PREFLIGHT_HEADERS = {
	"Access-Control-Request-Headers": "content-type",
	"Access-Control-Request-Method": "DELETE",
	Origin: "http://localhost:3001",
};

describe("app", () => {
	it("answers the container health probe", async () => {
		const response = await app.request("/");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("advertises every method a CRUD surface needs", async () => {
		const response = await app.request("/api/projects", {
			headers: PREFLIGHT_HEADERS,
			method: "OPTIONS",
		});

		expect(response.status).toBe(204);
		expect(
			response.headers.get("access-control-allow-methods")?.split(",")
		).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
	});
});

// CORS is registered ahead of the logger and the Better Auth identifier. The
// only observable proof is that a preflight produces no wide event at all,
// because nothing downstream of CORS ever runs for it.
describe("middleware order", () => {
	afterEach(() => {
		initLogger({ drain: () => Promise.resolve(), silent: true });
	});

	it("short-circuits a preflight before anything downstream runs", async () => {
		const events: DrainContext[] = [];
		initLogger({
			drain: (context) => {
				events.push(context);
			},
			silent: true,
		});

		await app.request("/api/projects", {
			headers: PREFLIGHT_HEADERS,
			method: "OPTIONS",
		});
		expect(events).toHaveLength(0);

		await app.request("/");
		expect(events).toHaveLength(1);
		expect(events[0]?.event.path).toBe("/");
		expect(events[0]?.event.requestId).toBeString();
	});
});
