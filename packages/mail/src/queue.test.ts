// First, and before anything reaches @keel/env: the bootstrap this suite needs
// is a preload when `bun test` runs inside the package, and this import is what
// makes `bun test packages/mail/src/queue.test.ts` from the repository root work
// too — bunfig.toml is only read from the working directory.
import "../test-setup";

import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";

import type { MailMessage } from "./message";
import { enqueueMail } from "./queue";

/**
 * The assertions go through the pool directly rather than Drizzle, because this
 * package has no business knowing the queue's schema module — it knows one
 * function. The `job` table's columns are the contract being checked here, so
 * naming them is the point.
 */
const client = db.$client;

/**
 * Written out rather than imported from `apps/server/test-db` for the same
 * reason `enqueue` had to move into `@keel/db`: a package cannot import app
 * code. The behaviour it preserves is what matters — a developer with no
 * database gets a green run and a loud skip, never a silent pass.
 */
async function testDbReady(): Promise<boolean> {
	try {
		const { rows } = await client.query<{ ready: boolean }>(
			"select to_regclass('public.job') is not null as ready"
		);
		return rows[0]?.ready === true;
	} catch {
		return false;
	}
}

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(
		"\n[skip] mail queue needs the test database.\n        bun run db:test:start && bun run db:test:migrate\n"
	);
}

/** Every key this run created, so the table is left as it was found. */
const keys: string[] = [];

/**
 * A distinct key per test. The dedupe index spans the whole table, so a fixed
 * key would make two runs — or a run beside the server's queue suite — collide
 * on rows neither of them wrote.
 */
function freshKey(): string {
	const key = `mail:test:${crypto.randomUUID()}`;
	keys.push(key);
	return key;
}

function messageFor(marker: string): MailMessage {
	return {
		html: `<p>${marker}</p>`,
		subject: "Confirm your email address",
		text: `Confirm your address: https://keel.test/verify?token=${marker}`,
		to: "recipient@example.com",
	};
}

async function pendingFor(dedupeKey: string) {
	const { rows } = await client.query<{ kind: string; payload: MailMessage }>(
		"select kind, payload from job where dedupe_key = $1 and status = 'pending'",
		[dedupeKey]
	);
	return rows;
}

describe.skipIf(!ready)("enqueueMail", () => {
	afterEach(async () => {
		await client.query("delete from job where dedupe_key = any($1)", [
			keys.splice(0),
		]);
	});

	it("queues the rendered message as a mail.send job", async () => {
		const dedupeKey = freshKey();
		const message = messageFor(dedupeKey);

		await enqueueMail(message, dedupeKey);
		const rows = await pendingFor(dedupeKey);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("mail.send");
		// The whole message, not a reference to one: the worker sends exactly what
		// was rendered inside the request that minted the token, because the token
		// cannot be derived again afterwards.
		expect(rows[0]?.payload).toEqual(message);
	});

	it("collapses a repeat of the same key into the job already waiting", async () => {
		const dedupeKey = freshKey();
		const first = messageFor("first");

		// What "resend verification" pressed twice looks like from the queue's side.
		await enqueueMail(first, dedupeKey);
		await enqueueMail(messageFor("second"), dedupeKey);
		const rows = await pendingFor(dedupeKey);

		expect(rows).toHaveLength(1);
		// The one still waiting wins, and the second message is dropped rather than
		// queued behind it. One press, one email.
		expect(rows[0]?.payload).toEqual(first);
	});

	it("frees the key once the pending job is gone", async () => {
		const dedupeKey = freshKey();
		const second = messageFor("second");

		await enqueueMail(messageFor("first"), dedupeKey);
		// Standing in for the worker settling it: the unique index covers only
		// `pending`, so a job that has run releases its key for a genuine resend.
		await client.query("update job set status = 'done' where dedupe_key = $1", [
			dedupeKey,
		]);
		await enqueueMail(second, dedupeKey);

		const rows = await pendingFor(dedupeKey);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.payload).toEqual(second);
	});
});
