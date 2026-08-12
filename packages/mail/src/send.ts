import type { MailMessage } from "./message";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * How long one Resend call may take, connection through body.
 *
 * Unbounded, this is not one slow message. The worker runs a claimed batch one
 * job at a time (`runOnce` in apps/server/src/lib/jobs.ts), so a socket the
 * provider never answers stops every other kind of work in the process, and the
 * 10s drain deadline in apps/server/src/worker.ts then turns a graceful
 * shutdown into `process.exit(1)` with the row still `running`.
 *
 * Eight seconds is roughly an order of magnitude above a normal answer — the
 * endpoint accepts a message and queues it, it does not wait for delivery — and
 * is deliberately under that drain deadline, so one hung send cannot on its own
 * force the kill. A whole batch of hung sends still can; that is what a reaper
 * is for, not a timeout.
 *
 * A constant rather than an environment key, for the same reason
 * `DEFAULT_TIMEOUT_MS` in @keel/ai is one: this package reads no environment,
 * and a socket budget is a decision the repository is better placed to make
 * than every deployment that would otherwise have to name it in order to boot.
 */
export const RESEND_TIMEOUT_MS = 8000;

export interface MailConfig {
	/** Required when `driver` is `resend`. */
	apiKey?: string;
	driver: "log" | "resend";
	from: string;
	/**
	 * Overrides `RESEND_TIMEOUT_MS` for this config. Nothing in a deployment
	 * sets it — `resolveMailConfig` does not — and it exists so a test can pick a
	 * budget it can afford to wait out.
	 */
	timeoutMs?: number;
}

/**
 * Prints the whole message instead of sending it.
 *
 * This is what a laptop wants, which is not the same as being what a laptop gets:
 * `MAIL_DRIVER` has no default, so a contributor who clones the repo names `log`
 * and can then sign up, verify an address and accept an invitation without
 * registering for a provider, verifying a domain, or holding an API key. Naming it
 * is the point — a deployment that inherited this driver would silently deliver
 * nothing, and it is the server, not the repository, that knows which it wants.
 *
 * The banner says NOT SENT in as many words so a log reader never reads a dump
 * here as evidence that mail is working.
 */
function writeToLog(
	config: MailConfig,
	message: MailMessage,
	idempotencyKey: string
): void {
	process.stdout.write(
		[
			"[mail] NOT SENT — MAIL_DRIVER=log, this message only went to stdout",
			`[mail] key:     ${idempotencyKey}`,
			`[mail] from:    ${config.from}`,
			`[mail] to:      ${message.to}`,
			`[mail] subject: ${message.subject}`,
			"[mail] ── text ──",
			message.text,
			"[mail] ── html ──",
			message.html,
			"[mail] ── end ──",
			"",
		].join("\n")
	);
}

async function sendViaResend(
	config: MailConfig,
	message: MailMessage,
	idempotencyKey: string
): Promise<void> {
	if (!config.apiKey) {
		// A programmer error, not a runtime condition: whoever resolves the driver
		// resolves the key with it and fails at startup. Degrading to `log` here
		// would turn a misconfigured production deployment into one that looks
		// healthy while delivering nothing.
		throw new Error(
			'MailConfig.apiKey is required when driver is "resend". Resolve the driver and the key together, and fail at startup rather than at the first send.'
		);
	}

	const timeoutMs = config.timeoutMs ?? RESEND_TIMEOUT_MS;

	// One signal, created once, covering both phases. Handing it to `fetch` also
	// errors the response body stream, so the `response.text()` below is on the
	// same budget as the request that produced it — a provider whose headers
	// arrive and whose body never completes hangs exactly as hard as one that
	// never answers, and a second signal would silently grant it twice the time.
	const signal = AbortSignal.timeout(timeoutMs);

	try {
		const response = await fetch(RESEND_ENDPOINT, {
			body: JSON.stringify({
				from: config.from,
				html: message.html,
				subject: message.subject,
				text: message.text,
				to: [message.to],
			}),
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				// The queue retries a failed job, and the most common failure is a
				// timeout — which is indistinguishable from a slow success, because the
				// message may well have been accepted and delivered before the socket
				// gave up. Without this header that retry is a second copy in the
				// recipient's inbox; with it Resend replays the first outcome. The key
				// is the job id, so every attempt at one job carries the same value.
				"Idempotency-Key": idempotencyKey,
			},
			method: "POST",
			signal,
		});

		if (!response.ok) {
			// Status and body both, because the worker stores this string as the job's
			// `lastError` and that is all anyone will have to work from: 403 with a
			// domain-not-verified body and 429 with a rate-limit body need entirely
			// different fixes, and "send failed" distinguishes neither. The API key is
			// never interpolated — a job row is not a secret store.
			throw new Error(
				`Resend rejected the message: ${response.status} ${await response.text()}`
			);
		}
	} catch (error) {
		// Only the abort is reclassified. A refused connection, a DNS failure and
		// the rejection above all carry a message that already says what happened,
		// and burying them under "did not answer" would cost the operator the one
		// line the job row keeps.
		if (signal.aborted) {
			// The abort's own error is a DOMException reading "The operation timed
			// out." — it names neither the provider, nor the budget, nor the fact
			// that the retry is safe, and `job.last_error` is where it lands. The
			// original travels as `cause` for a local stack rather than being
			// concatenated into a string a human has to read in a database row.
			throw new Error(
				`Resend did not answer within ${timeoutMs}ms, so the request was aborted. Retrying is safe: every attempt carries the same Idempotency-Key, so a message the provider did accept cannot be delivered twice.`,
				{ cause: error }
			);
		}

		throw error;
	}
}

/**
 * Delivers one rendered message through the configured driver.
 *
 * Config is an argument rather than an import: this package reads no
 * environment, so a test constructs a driver directly and the app owns the one
 * place where `MAIL_DRIVER` is turned into a `MailConfig`.
 */
export function sendMail(
	config: MailConfig,
	message: MailMessage,
	idempotencyKey: string
): Promise<void> {
	if (config.driver === "log") {
		writeToLog(config, message, idempotencyKey);

		return Promise.resolve();
	}

	return sendViaResend(config, message, idempotencyKey);
}
