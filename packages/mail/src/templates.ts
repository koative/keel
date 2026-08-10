import type { MailMessage } from "./message";

interface InvitationInput {
	/** How to name the person who sent it — a display name, or their address. */
	inviter: string;
	organization: string;
	to: string;
	url: string;
}

interface LinkInput {
	to: string;
	url: string;
}

interface Layout {
	/** The label on the link. */
	action: string;
	heading: string;
	/** Paragraphs of prose, in order, above the link. */
	lines: string[];
	url: string;
}

const HTML_ESCAPES: Record<string, string> = {
	"'": "&#39;",
	'"': "&quot;",
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
};

/**
 * Nothing interpolated below is chosen by the reader.
 *
 * An organization name and an inviter's name are written by another user and
 * land inside an attribute and a paragraph, and a signed URL carries `&`
 * between its query parameters. Escaping is what keeps `Acme" onmouseover="` a
 * name rather than markup, and what stops `&token=` being read as an entity.
 */
function escapeHtml(value: string): string {
	return value.replace(
		/["&'<>]/g,
		(character) => HTML_ESCAPES[character] ?? character
	);
}

/** Shown beside the link in the html body. */
const FALLBACK =
	"If the link does not open, paste this address into your browser:";

/**
 * The shell every template renders into.
 *
 * Mail clients are not browsers. There is no shared CSS baseline, a stylesheet
 * in the head is routinely dropped, and several clients rewrite the markup they
 * keep. So this is deliberately unambitious: one column, inline styles only, no
 * table scaffolding, and a document that still reads as ordered prose if every
 * style is stripped. Anything more would be a maintenance burden paid in
 * rendering bugs nobody here can reproduce.
 *
 * The URL appears as visible text as well as an `href`, in both bodies, because
 * a client that strips anchors leaves a reader with a button-shaped nothing and
 * no way to continue.
 */
function render(layout: Layout): { html: string; text: string } {
	const url = escapeHtml(layout.url);
	const paragraphs = layout.lines
		.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
		.join("");

	return {
		html: `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;color:#111827;max-width:480px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(layout.heading)}</h1>${paragraphs}<p style="margin:0 0 16px"><a href="${url}" style="color:#1d4ed8">${escapeHtml(layout.action)}</a></p><p style="margin:0;font-size:14px;color:#6b7280">${FALLBACK}<br />${url}</p></div>`,
		text: `${layout.heading}\n\n${layout.lines.join("\n\n")}\n\n${layout.action}:\n${layout.url}\n`,
	};
}

/** For `emailVerification.sendVerificationEmail`, which supplies user and url. */
export function verificationEmail(input: LinkInput): MailMessage {
	const subject = "Confirm your email address";
	const { html, text } = render({
		action: "Confirm this address",
		heading: subject,
		lines: [
			"Confirm this address to finish setting up your account.",
			"If you did not sign up, ignore this message — the address is not used for anything until the link is opened.",
		],
		url: input.url,
	});

	return { html, subject, text, to: input.to };
}

/** For `emailAndPassword.sendResetPassword`, which supplies user and url. */
export function passwordResetEmail(input: LinkInput): MailMessage {
	const subject = "Reset your password";
	const { html, text } = render({
		action: "Choose a new password",
		heading: subject,
		lines: [
			"Someone asked to reset the password on this account.",
			"If that was not you, ignore this message — the link works once, and your current password keeps working until it is used.",
		],
		url: input.url,
	});

	return { html, subject, text, to: input.to };
}

/**
 * For `organization.sendInvitationEmail`, which supplies the invited address,
 * the organization, the inviter and the invitation.
 *
 * The organization and the inviter are named in the subject as well as the
 * body: an invitation arrives unsolicited, at an address that may never have
 * seen this product, and who sent it and to what is the only thing that
 * distinguishes it from a phishing attempt.
 */
export function invitationEmail(input: InvitationInput): MailMessage {
	const subject = `${input.inviter} invited you to join ${input.organization}`;
	const { html, text } = render({
		action: "Accept the invitation",
		heading: `Join ${input.organization}`,
		lines: [
			`${input.inviter} invited you to join ${input.organization}.`,
			"If you were not expecting this, ignore the message — nothing is shared with you until you accept.",
		],
		url: input.url,
	});

	return { html, subject, text, to: input.to };
}
