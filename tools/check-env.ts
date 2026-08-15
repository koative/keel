#!/usr/bin/env bun
/**
 * Guards the server env schema against the two files that must agree with it.
 *
 * `packages/env` validates the whole schema at import, so a key it declares is a
 * key every deployment has to be able to supply. Two files carry that contract
 * outward: `.env.example` tells an operator the key exists, and
 * `docker-compose.prod.yml`'s `x-app-env` is the only thing that carries it
 * across the container boundary — every service there uses
 * `environment: *app-env` and no `env_file`, so a key missing from that block
 * is a key the deploy exported and the process never sees.
 *
 * That failure is silent in the worst way: the variable is set on the host, the
 * container starts, and a `resolve*` guard throws hours later naming a key the
 * operator did set. `AGENTS.md` states the rule — a new key goes in
 * `.env.example`, `apps/server/.env`, `.env.test` and `x-app-env` — and a rule
 * stated in prose is a rule that drifts. This is the same rule, executable.
 *
 * It also checks the shape of each forwarded value, because a key present in the
 * block but supplied by it is worse than a key missing from it: `MAIL_DRIVER:
 * log` deploys, and mails to stdout while looking healthy. No environment
 * variable gets a default, so a required key arrives as `${KEY:?...}` and an
 * optional one as `${KEY:-}` — never `${KEY:-something}`, never a literal
 * outside PINNED_LITERAL below.
 *
 * `.env.test` is deliberately not checked: it is a fixture holding only what a
 * test run needs, not a mirror of the schema.
 */
import { file } from "bun";

const SCHEMA = "packages/env/src/server.ts";
const EXAMPLE = ".env.example";
const COMPOSE = "docker-compose.prod.yml";

/**
 * The schema is read as text, never imported: importing it runs `createEnv`,
 * which validates the whole environment and throws in CI. A regex is enough
 * because Biome fixes the shape — every key in the `server: {}` object sits at
 * exactly two tabs, and every continuation line of a multi-line declaration sits
 * at three or more.
 */
const SCHEMA_KEY = /^\t\t([A-Z][A-Z0-9_]*):(.*)$/;
const SCHEMA_CONTINUATION = /^\t\t\t/;

/** `KEY=value` or the commented `# KEY=value` an optional key ships as. */
const EXAMPLE_KEY = /^#?\s*([A-Z][A-Z0-9_]*)=/;

/**
 * The compose file is parsed by hand rather than with a YAML library, because
 * this repository has no YAML dependency — `yaml` and `js-yaml` exist in the
 * lockfile only as transitive dependencies of tooling, and reaching into a
 * package no manifest declares is a break waiting for the next `bun update`.
 * Adding one to the catalog to read a flat map of scalars is not worth it:
 * `x-app-env` has no nesting, no lists and no anchors of its own.
 */
const COMPOSE_ANCHOR = /^x-app-env:/;
const COMPOSE_ENTRY = /^ {2}([A-Za-z_][A-Za-z0-9_]*): *(.*)$/;
const COMPOSE_TOP_LEVEL = /^\S/;

/**
 * Forwarded on purpose and absent from the schema. `TZ` is a container concern —
 * it pins the clock the Postgres client and Better Auth's `timestamp` columns
 * agree on — not a value `@keel/env` reads.
 */
const NOT_IN_SCHEMA: Record<string, true> = { TZ: true };

/**
 * The two keys `x-app-env` sets to a literal instead of forwarding, and why each
 * is not a default: `NODE_ENV` is what makes this file the production topology,
 * and `DATABASE_URL` is composed here from `POSTGRES_PASSWORD` and `POSTGRES_DB`
 * so the server and Postgres cannot disagree about the credentials. Every other
 * key must arrive from the deploy environment — a literal anywhere else is the
 * default this repository does not allow.
 */
const PINNED_LITERAL: Record<string, true> = {
	DATABASE_URL: true,
	NODE_ENV: true,
};

function schemaKeys(source: string): Map<string, boolean> {
	const keys = new Map<string, boolean>();
	let name: string | undefined;
	let declaration = "";

	for (const line of source.split("\n")) {
		const match = SCHEMA_KEY.exec(line);

		if (match?.[1]) {
			if (name) {
				keys.set(name, declaration.includes(".optional()"));
			}
			[, name, declaration = ""] = match;
			continue;
		}

		if (name && SCHEMA_CONTINUATION.test(line)) {
			declaration += line;
			continue;
		}

		if (name) {
			keys.set(name, declaration.includes(".optional()"));
			name = undefined;
		}
	}

	if (name) {
		keys.set(name, declaration.includes(".optional()"));
	}

	return keys;
}

function documentedKeys(source: string): Set<string> {
	const keys = new Set<string>();

	for (const line of source.split("\n")) {
		const match = EXAMPLE_KEY.exec(line);

		if (match?.[1]) {
			keys.add(match[1]);
		}
	}

	return keys;
}

function forwardedKeys(source: string): Map<string, string> {
	const keys = new Map<string, string>();
	let inside = false;

	for (const line of source.split("\n")) {
		if (COMPOSE_ANCHOR.test(line)) {
			inside = true;
			continue;
		}

		if (!inside) {
			continue;
		}

		// The next top-level key ends the block. Comments and blank lines inside it
		// are indented or empty and simply do not match COMPOSE_ENTRY.
		if (COMPOSE_TOP_LEVEL.test(line)) {
			break;
		}

		const match = COMPOSE_ENTRY.exec(line);

		if (match?.[1]) {
			keys.set(match[1], (match[2] ?? "").trim());
		}
	}

	return keys;
}

const [schemaSource, exampleSource, composeSource] = await Promise.all([
	file(SCHEMA).text(),
	file(EXAMPLE).text(),
	file(COMPOSE).text(),
]);

const declared = schemaKeys(schemaSource);
const documented = documentedKeys(exampleSource);
const forwarded = forwardedKeys(composeSource);
const problems: string[] = [];

if (declared.size === 0 || forwarded.size === 0) {
	console.error(
		`check-env: parsed ${declared.size} schema keys and ${forwarded.size} x-app-env keys. One of the two files changed shape — fix this script before trusting it.`
	);
	process.exit(1);
}

for (const [key, optional] of declared) {
	if (!documented.has(key)) {
		problems.push(
			`${EXAMPLE}: ${key} is declared in ${SCHEMA} but documented nowhere here. Add it${optional ? " commented out, under the Optional heading" : ""}.`
		);
	}

	const value = forwarded.get(key);

	if (value === undefined) {
		problems.push(
			`${COMPOSE}: x-app-env does not forward ${key}. Every service there uses \`environment: *app-env\` and no env_file, so the deploy would export it and the container would never see it. Add \`${key}: ${optional ? `\${${key}:-}` : `\${${key}:?${key} is required}`}\`.`
		);
		continue;
	}

	if (PINNED_LITERAL[key]) {
		continue;
	}

	if (optional) {
		if (value.includes(":?")) {
			problems.push(
				`${COMPOSE}: x-app-env forwards the optional key ${key} as \`${value}\`. The \`:?\` form refuses the deploy when it is unset, which turns an opt-in feature into a requirement. Use \`\${${key}:-}\`.`
			);
		} else if (value !== `\${${key}:-}`) {
			problems.push(
				`${COMPOSE}: x-app-env forwards the optional key ${key} as \`${value}\`, which supplies a value the deploy did not set. No environment variable gets a default here. Use \`\${${key}:-}\`, which passes an absent variable through as absent.`
			);
		}

		continue;
	}

	if (!value.startsWith(`\${${key}:?`)) {
		problems.push(
			`${COMPOSE}: x-app-env forwards the required key ${key} as \`${value}\` instead of \`\${${key}:?${key} is required}\`. A value this file supplies is a default, and a default is how a deployment ends up running on it while looking healthy. Add it to PINNED_LITERAL in this script only if the literal is the point, as it is for NODE_ENV.`
		);
	}
}

for (const key of forwarded.keys()) {
	if (!(declared.has(key) || NOT_IN_SCHEMA[key])) {
		problems.push(
			`${COMPOSE}: x-app-env forwards ${key}, which ${SCHEMA} does not declare. Nothing reads it — check the spelling, or add it to NOT_IN_SCHEMA in this script if it is a container concern.`
		);
	}
}

// The block is alphabetical so it reads side by side with the schema, which is
// too. Nothing else enforces it, so an inserted key lands wherever the diff was
// convenient.
const order = [...forwarded.keys()];
const sorted = [...order].sort();
const misplaced = order.findIndex((key, index) => key !== sorted[index]);

if (misplaced !== -1) {
	problems.push(
		`${COMPOSE}: x-app-env lists ${order[misplaced]} out of alphabetical order. The block is sorted so it can be read against the \`server: {}\` object in ${SCHEMA}, which is sorted too.`
	);
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	console.error(`\ncheck-env: ${problems.length} problem(s).`);
	process.exit(1);
}

console.log(
	`check-env: ${declared.size} schema keys documented in ${EXAMPLE} and forwarded by ${COMPOSE}.`
);
