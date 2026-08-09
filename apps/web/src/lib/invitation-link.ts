/**
 * There is no mailer, so an invitation is delivered by copying this link out of
 * the members screen and sending it by hand. It is built against the SPA origin
 * rather than the API origin because the route that consumes it lives here, and
 * it is the reason invitations are given a seven-day lifetime: a human has to
 * carry the link across to another channel.
 */
export function invitationLink(invitationId: string): string {
	return new URL(
		`/accept-invitation/${invitationId}`,
		window.location.origin
	).toString();
}
