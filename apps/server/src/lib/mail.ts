import { env, SANDBOX_MAIL_FROM } from "@keel/env/server";
import type { MailConfig } from "@keel/mail/send";

/**
 * The three deployment inputs `resolveMailConfig` reads.
 *
 * Taken as a parameter rather than closed over so the startup guard below can be
 * exercised without a process-wide environment: the guard is the only reason
 * this function exists, and a guard nobody has seen fire is not a guard.
 */
export interface MailEnv {
	MAIL_DRIVER: "log" | "resend";
	MAIL_FROM: string;
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
