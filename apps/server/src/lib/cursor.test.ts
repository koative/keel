import { describe, expect, it } from "bun:test";
import { type Cursor, decodeCursor, encodeCursor } from "./cursor";

const CURSOR: Cursor = {
	createdAt: new Date("2026-01-01T12:34:56.789Z"),
	id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};

const QUERY_SAFE = /^[\w-]+$/;

const packed = (payload: string) =>
	Buffer.from(payload, "utf8").toString("base64url");

describe("encodeCursor", () => {
	it("round-trips through decode", () => {
		expect(decodeCursor(encodeCursor(CURSOR))).toEqual(CURSOR);
	});

	// Base64url, not base64: the token travels in a query string, where "+" is a
	// space and "/" ends a path segment.
	it("emits nothing a query string would mangle", () => {
		expect(encodeCursor(CURSOR)).toMatch(QUERY_SAFE);
	});

	it("is opaque — the timestamp is not readable at a glance", () => {
		expect(encodeCursor(CURSOR)).not.toContain("2026");
	});
});

/**
 * Every one of these is a client mistake, so every one has to come back as
 * `null` for the validator to turn into a 422. A throw here would surface as a
 * 500: the server blaming itself for a token somebody hand-edited.
 */
describe("decodeCursor", () => {
	it.each([
		["empty", ""],
		["not base64 at all", "!!!!"],
		["base64 of nothing useful", packed("garbage")],
		["no separator", packed("2026-01-01T00:00:00.000Zabc")],
		["empty id", packed("2026-01-01T00:00:00.000Z|")],
		["empty timestamp", packed("|abc")],
		["unparseable timestamp", packed("not-a-date|abc")],
		["loose date spelling", packed("2026-1-1|abc")],
		["ISO without milliseconds", packed("2026-01-01T00:00:00Z|abc")],
		["local time, no zone", packed("2026-01-01T00:00:00.000|abc")],
		["separator only", packed("|")],
	])("returns null for %s", (_name, raw) => {
		expect(decodeCursor(raw)).toBeNull();
	});

	it("keeps an id containing the separator out of the timestamp", () => {
		expect(decodeCursor(packed("2026-01-01T00:00:00.000Z|a|b"))).toEqual({
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			id: "a|b",
		});
	});
});
