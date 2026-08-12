import { env, SANDBOX_MAIL_FROM } from "@keel/env/server";
import type { MailConfig } from "@keel/mail/send";

/**
 * The four deployment inputs `resolveMailConfig` reads.
 *
 * Taken as a parameter rather than closed over so the startup guard below can be
 * exercised without a process-wide environment: the guard is the only reason
 * this function exists, and a guard nobody has seen fire is not a guard.
 *
 * NODE_ENV is here because one of the guards is about the deployment rather than
 * the driver: `log` is correct on a laptop and a credential leak on a server.
 */
export interface MailEnv {
	MAIL_DRIVER: "log" | "resend";
	MAIL_FROM: string;
	NODE_ENV: "development" | "production" | "test";
	RESEND_API_KEY?: string | undefined;
}

/**
 * The config `sendMail` receives, selected by MAIL_DRIVER. The counterpart of
 * `resolveDrain` in `observability.ts`, and the only file that knows both the
 * environment and the mail package.
 *
 * Both `resend` guards below throw here, at startup, instead of letting the
 * process boot into a state where mail is accepted and never arrives. That is
 * the expensive failure: a deployment that looks completely healthy, and the
 * first report coming from a user saying they never received anything. Refusing
 * to boot is louder and cheaper than either silent alternative.
 */
export function resolveMailConfig(source: MailEnv = env): MailConfig {
	// The log driver prints `message.text` and `message.html` in full, and a
	// verification or password-reset body is a live one-time link — the same
	// payload `tasks.ts` sweeps out of the job table early because it is "a live
	// one-time link at rest". Container logs are retained and aggregated far more
	// widely than the database, so on a server that dump is a credential store
	// nobody decided to run. Nothing else refuses it: `.env.example` ships
	// MAIL_DRIVER=log, the production compose file accepts it, and the deployment
	// that results looks completely healthy.
	//
	// No opt-out key. A key whose only job is to disarm this would have to be
	// documented to be usable, and a documented way to log credentials is one that
	// gets used. A host that reports production and must not mail real people uses
	// `resend` with its own key and its own verified domain — which is also the
	// only way to find out whether delivery works before real users do.
	if (source.NODE_ENV === "production" && source.MAIL_DRIVER === "log") {
		throw new Error(
			"MAIL_DRIVER=log is refused when NODE_ENV=production. The log driver prints every message to stdout, and a verification or password-reset message holds a live one-time link, so each one would be written to the container logs. Set NODE_ENV to the environment this deployment actually is, or set MAIL_DRIVER to resend with a RESEND_API_KEY and a verified MAIL_FROM."
		);
	}

	if (source.MAIL_DRIVER === "resend") {
		if (!source.RESEND_API_KEY) {
			throw new Error(
				"MAIL_DRIVER=resend requires RESEND_API_KEY. Set RESEND_API_KEY to a Resend API key, or set MAIL_DRIVER to log."
			);
		}

		// The MAIL_FROM default is Resend's sandbox sender, which only delivers to
		// the account owner's own address. Left in place it is not a warning but a
		// total delivery failure, and a quiet one: every message is accepted here,
		// queued, retried five times and settles as `failed`, with the reason
		// visible only in `job.last_error`.
		if (source.MAIL_FROM === SANDBOX_MAIL_FROM) {
			throw new Error(
				`MAIL_DRIVER=resend requires MAIL_FROM to be an address on a domain verified with Resend. "${SANDBOX_MAIL_FROM}" is the sandbox sender and only reaches the account owner, so every other recipient would silently fail.`
			);
		}

		return {
			apiKey: source.RESEND_API_KEY,
			driver: "resend",
			from: source.MAIL_FROM,
		};
	}

	// `log` is the development default: it needs no account, and writing the
	// whole message to stdout is how a developer reads a verification link.
	return { driver: "log", from: source.MAIL_FROM };
}
