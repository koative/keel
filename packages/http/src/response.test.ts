import { afterEach, describe, expect, it } from "bun:test";
import { type DrainContext, initLogger } from "evlog";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { notFound as notFoundError } from "./errors";
import {
	badRequest,
	conflict,
	created,
	echoRequestId,
	errorSchema,
	failure,
	noContent,
	notFound,
	ok,
} from "./response";

const LEAKED_SECRET = "postgres://admin:hunter2@10.0.0.4/prod";
const UUID = /^[0-9a-f-]{36}$/;

const app = new Hono()
	.use(evlog())
	.use(echoRequestId)
	.onError((error, c) => failure(c, error))
	.get("/ok", (c) => ok(c, { id: "p1" }))
	.post("/created", (c) => created(c, { id: "p1" }))
	.delete("/no-content", (c) => noContent(c))
	.get("/not-found", (c) => notFound(c, "Project"))
	.get("/conflict", (c) => conflict(c, "Project", "slug"))
	.get("/bad-request", (c) => badRequest(c, "cursor is not a valid timestamp"))
	.get("/thrown-not-found", () => {
		throw notFoundError("Project");
	})
	.get("/crash", () => {
		throw new Error(`connect ECONNREFUSED ${LEAKED_SECRET}`);
	});

describe("success envelope", () => {
	it("wraps a payload in data", async () => {
		const response = await app.request("/ok");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { id: "p1" } });
	});

	it("uses 201 for created", async () => {
		const response = await app.request("/created", { method: "POST" });

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ data: { id: "p1" } });
	});

	it("sends no body for 204", async () => {
		const response = await app.request("/no-content", { method: "DELETE" });

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
	});
});

describe("error envelope", () => {
	it.each([
		["/not-found", 404, "NOT_FOUND"],
		["/conflict", 409, "CONFLICT"],
		["/bad-request", 400, "BAD_REQUEST"],
	])(
		"renders %s as %i with a self-describing body",
		async (path, expectedStatus, expectedCode) => {
			const response = await app.request(path);
			const body = errorSchema.parse(await response.json());

			expect(response.status).toBe(expectedStatus);
			expect(body.error.code).toBe(expectedCode);
			expect(body.error.why).toBeString();
			expect(body.error.fix).toBeString();
		}
	);

	it("renders a thrown error identically to a returned one", async () => {
		const returned = await (await app.request("/not-found")).json();
		const thrown = await (await app.request("/thrown-not-found")).json();

		const withoutId = (body: unknown) => ({
			...errorSchema.parse(body).error,
			requestId: "",
		});
		expect(withoutId(thrown)).toEqual(withoutId(returned));
	});
});

describe("unexpected failures", () => {
	it("never forwards the thrown message", async () => {
		const response = await app.request("/crash");
		const raw = await response.text();

		expect(response.status).toBe(500);
		expect(raw).not.toContain(LEAKED_SECRET);
		expect(raw).not.toContain("ECONNREFUSED");
		expect(errorSchema.parse(JSON.parse(raw)).error).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Something went wrong",
		});
	});
});

describe("request correlation", () => {
	it("echoes an inbound x-request-id", async () => {
		const response = await app.request("/ok", {
			headers: { "x-request-id": "trace-42" },
		});

		expect(response.headers.get("x-request-id")).toBe("trace-42");
	});

	it("generates an id when the caller sends none", async () => {
		const response = await app.request("/ok");

		expect(response.headers.get("x-request-id")).toMatch(UUID);
	});

	it("reports the same id in the header and the error body", async () => {
		const response = await app.request("/crash", {
			headers: { "x-request-id": "trace-99" },
		});

		expect(response.headers.get("x-request-id")).toBe("trace-99");
		expect(errorSchema.parse(await response.json()).error.requestId).toBe(
			"trace-99"
		);
	});
});

// evlog folds everything about a request into one event, so severity is decided
// once, in `failure`, and cannot be downgraded afterwards.
describe("wide event severity", () => {
	const events: DrainContext[] = [];

	const collect = () => {
		events.length = 0;
		initLogger({
			drain: (context) => {
				events.push(context);
			},
			silent: true,
		});
	};

	afterEach(() => {
		initLogger({ drain: () => Promise.resolve(), silent: true });
	});

	it("emits exactly one event per request, not one per log call", async () => {
		collect();
		await app.request("/crash");

		expect(events).toHaveLength(1);
	});

	it("records a client mistake at warn, not error", async () => {
		collect();
		await app.request("/thrown-not-found");

		expect(events[0]?.event.level).toBe("warn");
		expect(events[0]?.event.errorCode).toBe("NOT_FOUND");
	});

	it("records a server failure at error, with the stack the client never sees", async () => {
		collect();
		await app.request("/crash");

		expect(events[0]?.event.level).toBe("error");
		expect(JSON.stringify(events[0]?.event.error)).toContain(LEAKED_SECRET);
	});
});

// `failure` is the app's last line of defence. If it throws, Hono has nothing
// left to render and the caller gets a bare 500 with no correlation id.
describe("failure without evlog installed", () => {
	const bare = new Hono()
		.use(echoRequestId)
		.onError((error, c) => failure(c, error))
		.get("/crash", () => {
			throw new Error("boom");
		})
		.get("/thrown-not-found", () => {
			throw notFoundError("Project");
		});

	it("renders a 500 rather than throwing out of the error handler", async () => {
		const response = await bare.request("/crash");
		const body = errorSchema.parse(await response.json());

		expect(response.status).toBe(500);
		expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(body.error.requestId).toBe("unknown");
	});

	it("keeps a 4xx a 4xx", async () => {
		const response = await bare.request("/thrown-not-found");

		expect(response.status).toBe(404);
		expect(errorSchema.parse(await response.json()).error.code).toBe(
			"NOT_FOUND"
		);
	});
});
