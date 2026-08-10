/**
 * One rendered message, ready to hand to a provider.
 *
 * Rendered, not renderable: a template is evaluated where its inputs exist —
 * inside the Better Auth request that mints the one-time token — and what
 * travels from there to the queue and on to the transport is the finished
 * text. Nothing downstream can re-render it, and nothing downstream needs to.
 */
export interface MailMessage {
	html: string;
	subject: string;
	text: string;
	to: string;
}
