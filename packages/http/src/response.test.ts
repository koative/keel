import { describe, expect, it } from "bun:test";
import { errorSchema } from "./envelope";
import { testApp } from "./test-app";

const UUID = /^[0-9a-f-]{36}$/;

describe("success envelope", () => {
	it("wraps a payload in data", async () => {
		const response = await testApp.request("/ok");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { id: "p1" } });
	});

	it("uses 201 for created", async () => {
		const response = await testApp.request("/created", { method: "POST" });

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ data: { id: "p1" } });
	});

	it("sends no body for 204", async () => {
		const response = await testApp.request("/no-content", { method: "DELETE" });

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
			const response = await testApp.request(path);
			const body = errorSchema.parse(await response.json());

			expect(response.status).toBe(expectedStatus);
			expect(body.error.code).toBe(expectedCode);
			expect(body.error.why).toBeString();
			expect(body.error.fix).toBeString();
		}
	);

	it("renders a thrown error identically to a returned one", async () => {
		const returned = await (await testApp.request("/not-found")).json();
		const thrown = await (await testApp.request("/thrown-not-found")).json();

		const withoutId = (body: unknown) => ({
			...errorSchema.parse(body).error,
			requestId: "",
		});
		expect(withoutId(thrown)).toEqual(withoutId(returned));
	});

	// RFC 9457. Without these an API gateway or a generated SDK has to be taught
	// our shape before it can recognise a failure.
	it.each([
		["/not-found", 404, "https://keel.dev/errors/not-found", "Not found"],
		["/conflict", 409, "https://keel.dev/errors/conflict", "Conflict"],
		["/bad-request", 400, "https://keel.dev/errors/bad-request", "Bad request"],
	])(
		"serves %s as a problem document",
		async (path, expectedStatus, expectedType, expectedTitle) => {
			const response = await testApp.request(path);
			const body = errorSchema.parse(await response.json());

			expect(response.headers.get("content-type")).toContain(
				"application/problem+json"
			);
			expect(body.type).toBe(expectedType);
			expect(body.title).toBe(expectedTitle);
			expect(body.status).toBe(expectedStatus);
		}
	);
});

describe("request correlation", () => {
	it("echoes an inbound x-request-id", async () => {
		const response = await testApp.request("/ok", {
			headers: { "x-request-id": "trace-42" },
		});

		expect(response.headers.get("x-request-id")).toBe("trace-42");
	});

	it("generates an id when the caller sends none", async () => {
		const response = await testApp.request("/ok");

		expect(response.headers.get("x-request-id")).toMatch(UUID);
	});

	it("reports the same id in the header and the error body", async () => {
		const response = await testApp.request("/crash", {
			headers: { "x-request-id": "trace-99" },
		});

		expect(response.headers.get("x-request-id")).toBe("trace-99");
		expect(errorSchema.parse(await response.json()).error.requestId).toBe(
			"trace-99"
		);
	});
});
