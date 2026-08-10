/**
 * Every object this app stores lives under one organization's prefix. A bucket
 * has no tenants of its own, so the prefix is the whole of tenant isolation for
 * storage: it is what a presigned URL is scoped to, and it is what makes
 * "list this organization's files" a bounded question.
 */
const ORGANIZATION_PREFIX = "org_";

/**
 * Better Auth ids are URL-safe generated ids. Pinning the shape here means a
 * caller cannot slip a path, a wildcard or an empty string in through the one
 * argument that decides which tenant a write lands on.
 */
const ORGANIZATION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * S3 refuses a key over 1024 bytes. Checked here so an over-long filename fails
 * where the name is built, naming the limit, rather than as a provider error on
 * the write that a caller has to go and look up.
 */
const MAX_KEY_BYTES = 1024;

/**
 * A path segment is attacker-influenced whenever any part of it came from an
 * upload form: a browser sends whatever filename the user chose, and a scripted
 * client sends whatever it likes. `photos/../../org_other/secret.pdf` is a
 * plausible value, not a hypothetical one, and S3 has no notion of a working
 * directory that would contain it — the key is taken literally, so a key
 * containing a separator simply addresses a different object.
 *
 * Rejecting is the only correct answer. Sanitising by stripping the offending
 * characters would silently rename a user's file and, worse, could collapse two
 * distinct names onto one key and overwrite the earlier upload.
 */
function assertSegment(segment: string): void {
	if (segment.length === 0) {
		throw new Error("Storage key segments cannot be empty.");
	}

	if (segment.includes("\0")) {
		throw new Error(
			`Storage key segment "${segment}" contains a NUL byte. A NUL truncates the name for some consumers, so the key that is written and the key that is checked can differ.`
		);
	}

	if (segment === "." || segment === "..") {
		throw new Error(
			`Storage key segment "${segment}" is a relative path segment. Pass the segments you mean; there is no directory to be relative to.`
		);
	}

	if (segment.includes("/")) {
		throw new Error(
			`Storage key segment "${segment}" contains "/". Pass each level as its own argument so no single value can widen the key it lands under.`
		);
	}

	if (segment.includes("\\")) {
		throw new Error(
			`Storage key segment "${segment}" contains a backslash. A Windows client sends backslash-separated names, and normalising one later would turn it into a separator.`
		);
	}
}

/**
 * Builds the key an organization's object is stored under, or throws.
 *
 * Keys are always built here from a resource the server already looked up, and
 * never accepted from a request body. That is what keeps a presigned URL honest:
 * the URL is signed for exactly one key, so if the key cannot escape the tenant
 * prefix then neither can the credential handed to the browser.
 */
export function organizationKey(
	organizationId: string,
	...segments: string[]
): string {
	if (!ORGANIZATION_ID.test(organizationId)) {
		throw new Error(
			`"${organizationId}" is not a usable organization id for a storage key. Expected one or more of A-Z a-z 0-9 _ -.`
		);
	}

	if (segments.length === 0) {
		throw new Error(
			"A storage key needs at least one segment after the organization prefix; a bare prefix addresses no object."
		);
	}

	for (const segment of segments) {
		assertSegment(segment);
	}

	const key = `${ORGANIZATION_PREFIX}${organizationId}/${segments.join("/")}`;
	const bytes = Buffer.byteLength(key, "utf8");

	if (bytes > MAX_KEY_BYTES) {
		throw new Error(
			`Storage key is ${bytes} bytes; S3 accepts at most ${MAX_KEY_BYTES}. Shorten the file name or hash it.`
		);
	}

	return key;
}
