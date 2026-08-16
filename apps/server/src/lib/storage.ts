import { env } from "@keel/env/server";
import { createStorage, type Storage } from "@keel/storage/client";
import {
	type ProviderInput,
	type ProviderInputKey,
	providerRequirements,
	resolveProviderEndpoint,
	type StorageProvider,
} from "@keel/storage/providers";

/**
 * The deployment inputs `resolveStorage` reads.
 *
 * A parameter rather than a closed-over import, for the same reason `MailEnv` is
 * one: the guards below are the only reason this function exists, and a guard
 * that cannot be exercised without a process-wide environment does not get
 * exercised.
 */
export interface StorageEnv {
	STORAGE_ACCESS_KEY_ID?: string | undefined;
	STORAGE_ACCOUNT_ID?: string | undefined;
	STORAGE_BUCKET?: string | undefined;
	STORAGE_ENDPOINT?: string | undefined;
	STORAGE_FORCE_PATH_STYLE?: boolean | undefined;
	STORAGE_PROVIDER?: StorageProvider | undefined;
	STORAGE_REGION?: string | undefined;
	STORAGE_SECRET_ACCESS_KEY?: string | undefined;
}

/**
 * The variable behind each provider input, so every message below names what an
 * operator would set rather than what the code calls it. The storage package
 * deals in inputs and knows nothing about the environment; this file is the only
 * place where the two vocabularies meet.
 */
const ENV_KEY: Record<ProviderInputKey, string> = {
	accountId: "STORAGE_ACCOUNT_ID",
	endpoint: "STORAGE_ENDPOINT",
	forcePathStyle: "STORAGE_FORCE_PATH_STYLE",
	region: "STORAGE_REGION",
};

/** `Object.keys` erases the key type; the Record above already fixes the set. */
const PROVIDER_INPUTS = Object.keys(ENV_KEY) as ProviderInputKey[];

function named(keys: ProviderInputKey[]): string {
	return keys.map((key) => ENV_KEY[key]).join(", ");
}

/**
 * The bucket the app talks to, or a refusal naming what is missing.
 *
 * Every storage variable is optional in `packages/env` on purpose, but this
 * function is live: `/api/storage` is mounted behind `requireUser`, `rateLimit`
 * and `requireOrg`, and `storage.handlers.ts` resolves on the first signed-in
 * request, so an unconfigured deployment answers 503 there rather than failing
 * to boot — a contributor who never touches uploads still never configures a
 * bucket. That is also why `docker-compose.yml` runs no local object store and
 * should not grow one: a presigned URL is signed against whichever provider a
 * deployment names, so a MinIO service to keep healthy and create buckets in
 * would only stand in for one, and a filesystem stub in its place would be a
 * second implementation of the one thing `@keel/storage` deliberately avoids
 * having. A deployment that wants uploads names a real provider, and that is the
 * same code path a developer would exercise locally against one.
 *
 * The counterpart of `resolveMailConfig` in `mail.ts` and `resolveDrain` in
 * `observability.ts`: the only file that knows both the environment and the
 * storage package.
 */
export function resolveStorage(source: StorageEnv = env): Storage {
	const {
		STORAGE_ACCESS_KEY_ID: accessKeyId,
		STORAGE_BUCKET: bucket,
		STORAGE_PROVIDER: provider,
		STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
	} = source;

	// One condition rather than four guards, so the four names are narrowed below
	// and the report still lists every one of them. All at once, because a bucket
	// needs all four before a provider is even considered, and revealing them one
	// restart at a time turns one mistake into four.
	if (!(accessKeyId && bucket && provider && secretAccessKey)) {
		const missing = (
			[
				["STORAGE_PROVIDER", provider],
				["STORAGE_BUCKET", bucket],
				["STORAGE_ACCESS_KEY_ID", accessKeyId],
				["STORAGE_SECRET_ACCESS_KEY", secretAccessKey],
			] as const
		)
			.filter(([, value]) => !value)
			.map(([name]) => name);

		throw new Error(
			`Storage is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset. .env.example lists what each provider needs.`
		);
	}

	const input: ProviderInput = {
		accountId: source.STORAGE_ACCOUNT_ID,
		bucket,
		endpoint: source.STORAGE_ENDPOINT,
		forcePathStyle: source.STORAGE_FORCE_PATH_STYLE,
		region: source.STORAGE_REGION,
	};
	const required = providerRequirements(provider);
	const absent = required.filter((key) => input[key] === undefined);

	if (absent.length > 0) {
		throw new Error(`STORAGE_PROVIDER=${provider} requires ${named(absent)}.`);
	}

	// A variable the chosen provider derives is not an override, it is a
	// misunderstanding: nothing would read it, and the deployment would go looking
	// for the resulting 403 in its credentials. Saying so costs one filter.
	const ignored = PROVIDER_INPUTS.filter(
		(key) => input[key] !== undefined && !required.includes(key)
	);

	if (ignored.length > 0) {
		const them = ignored.length === 1 ? "it" : "them";

		throw new Error(
			`STORAGE_PROVIDER=${provider} derives ${named(ignored)} and would ignore ${them}. Unset ${them}, or use STORAGE_PROVIDER=custom to state the endpoint and addressing style yourself.`
		);
	}

	return createStorage({
		accessKeyId,
		bucket,
		secretAccessKey,
		...resolveProviderEndpoint(provider, input),
	});
}
