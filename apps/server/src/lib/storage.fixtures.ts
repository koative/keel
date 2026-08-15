import type { StorageEnv } from "./storage";

/**
 * Credentials and bucket, which every provider needs and none can derive.
 *
 * Shared because two suites configure the same resolver: `storage.test.ts`
 * spreads a provider's own inputs over this to exercise one guard at a time,
 * and the storage route suite spreads a whole `custom` provider over it to get a
 * URL it can assert a host and path on. A second hand-written copy would let the
 * resolver's required inputs change under one of them.
 */
export const CREDENTIALS: StorageEnv = {
	STORAGE_ACCESS_KEY_ID: "key",
	STORAGE_BUCKET: "keel-files",
	STORAGE_SECRET_ACCESS_KEY: "secret",
};
