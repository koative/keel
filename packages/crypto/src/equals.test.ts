import { describe, expect, it } from "bun:test";
import { safeEquals } from "./equals";

describe("safeEquals", () => {
	it("is true for identical strings", () => {
		expect(safeEquals("sha256=abc123", "sha256=abc123")).toBe(true);
		expect(safeEquals("", "")).toBe(true);
	});

	it("is false for equal-length strings that differ", () => {
		expect(safeEquals("abcdef", "abcdeg")).toBe(false);
		// Differing in the first byte must behave like differing in the last.
		expect(safeEquals("abcdef", "zbcdef")).toBe(false);
	});

	it("is false for different lengths instead of throwing", () => {
		expect(safeEquals("abc", "abcd")).toBe(false);
		expect(safeEquals("abcd", "abc")).toBe(false);
		expect(safeEquals("", "a")).toBe(false);
	});

	it("compares bytes, so equal-length multi-byte input is handled", () => {
		expect(safeEquals("é", "é")).toBe(true);
		// Two characters, but four bytes against one — the length guard must read
		// the encoded form, not String.length.
		expect(safeEquals("éé", "ab")).toBe(false);
	});
});
