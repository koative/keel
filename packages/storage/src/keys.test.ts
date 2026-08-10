import { describe, expect, it } from "bun:test";
import { organizationKey } from "./keys";

const ORGANIZATION = "org1234567890";

/** Each rejection is identified by the reason it gives, which is its whole job. */
const BACKSLASH = /contains a backslash/;
const EMPTY_SEGMENT = /cannot be empty/;
const NO_SEGMENTS = /at least one segment/;
const NUL_BYTE = /NUL byte/;
const RELATIVE = /relative path segment/;
const SLASH = /contains "\//;
const TOO_LONG = /at most 1024/;
const UNUSABLE_ID = /not a usable organization id/;

describe("organizationKey", () => {
	it("puts every object under the organization's prefix", () => {
		expect(organizationKey(ORGANIZATION, "avatars", "me.png")).toBe(
			`org_${ORGANIZATION}/avatars/me.png`
		);
	});

	it("leaves an ordinary file name untouched", () => {
		// Dots, spaces and parentheses are not dangerous, and a user's file name
		// should survive the round trip: rejecting more than necessary pushes
		// callers into renaming files themselves, which is where collisions start.
		expect(organizationKey(ORGANIZATION, "Q1 report (final).v2.pdf")).toBe(
			`org_${ORGANIZATION}/Q1 report (final).v2.pdf`
		);
	});

	it("rejects a traversal segment", () => {
		expect(() => organizationKey(ORGANIZATION, "..", "secret.pdf")).toThrow(
			RELATIVE
		);
	});

	it("rejects a traversal hidden inside a segment", () => {
		// The form a filename actually arrives in: one string, separators included.
		expect(() =>
			organizationKey(ORGANIZATION, "photos/../../org_other/secret.pdf")
		).toThrow(SLASH);
	});

	it("rejects a leading slash", () => {
		// Why the check is on separators rather than on `..`: no path is normalised
		// here, so this simply addresses an object under a prefix nobody named.
		expect(() => organizationKey(ORGANIZATION, "/etc/passwd")).toThrow(SLASH);
	});

	it("rejects a backslash", () => {
		expect(() => organizationKey(ORGANIZATION, "..\\..\\secret.pdf")).toThrow(
			BACKSLASH
		);
	});

	it("rejects an embedded NUL", () => {
		expect(() => organizationKey(ORGANIZATION, "report.pdf\0.png")).toThrow(
			NUL_BYTE
		);
	});

	it("rejects an empty segment", () => {
		expect(() => organizationKey(ORGANIZATION, "avatars", "")).toThrow(
			EMPTY_SEGMENT
		);
	});

	it("rejects a single dot segment", () => {
		expect(() => organizationKey(ORGANIZATION, ".", "me.png")).toThrow(
			RELATIVE
		);
	});

	it("rejects a key with no segments", () => {
		expect(() => organizationKey(ORGANIZATION)).toThrow(NO_SEGMENTS);
	});

	it("rejects an organization id that is a path", () => {
		// The one argument that decides which tenant the write lands on.
		expect(() => organizationKey("../other", "me.png")).toThrow(UNUSABLE_ID);
	});

	it("rejects an empty organization id", () => {
		expect(() => organizationKey("", "me.png")).toThrow(UNUSABLE_ID);
	});

	it("rejects a key over the S3 limit", () => {
		expect(() => organizationKey(ORGANIZATION, "a".repeat(1024))).toThrow(
			TOO_LONG
		);
	});
});
