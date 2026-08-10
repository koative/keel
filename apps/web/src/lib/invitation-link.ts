/**
 * The invitation link, as shown on the members screen.
 *
 * A mailer now exists, so this is no longer the only way an invitation travels —
 * but it is not redundant either, and both reasons matter. A deployment may run
 * `MAIL_DRIVER=log`, which writes the message to stdout rather than sending it, and
 * there this is still the whole delivery mechanism. And even with a real provider,
 * mail goes missing: a wrong address, a spam folder, a corporate filter. Being able
 * to hand the link over directly is what keeps that from becoming a support
 * conversation.
 *
 * Built against the SPA origin rather than the API origin because the route that
 * consumes it lives here. It is also why invitations last seven days: whenever a
 * human is the transport, an expiry measured in hours is hostile.
 */
export function invitationLink(invitationId: string): string {
	return new URL(
		`/accept-invitation/${invitationId}`,
		window.location.origin
	).toString();
}
