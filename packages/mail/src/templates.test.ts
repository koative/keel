import { describe, expect, it } from "bun:test";
import type { MailMessage } from "./message";
import {
	invitationEmail,
	passwordResetEmail,
	verificationEmail,
} from "./templates";

const TO = "recipient@example.com";
const LINK = "https://keel.test/accept?token=abc&id=xyz";
const ESCAPED_LINK = "https://keel.test/accept?token=abc&amp;id=xyz";
const INVITER = "Ada Lovelace";
const ORGANIZATION = "Analytical Engines";

const messages: [string, MailMessage][] = [
	["verificationEmail", verificationEmail({ to: TO, url: LINK })],
	["passwordResetEmail", passwordResetEmail({ to: TO, url: LINK })],
	[
		"invitationEmail",
		invitationEmail({
			inviter: INVITER,
			organization: ORGANIZATION,
			to: TO,
			url: LINK,
		}),
	],
];

describe.each(messages)("%s", (_name, message) => {
	it("addresses the recipient and carries a subject", () => {
		expect(message.to).toBe(TO);
		expect(message.subject.length).toBeGreaterThan(0);
	});

	it("renders both bodies", () => {
		expect(message.text.length).toBeGreaterThan(0);
		expect(message.html.length).toBeGreaterThan(0);
	});

	it("puts the link in the text body, where nothing can strip it", () => {
		expect(message.text).toContain(LINK);
	});

	it("puts the link in the html body as an href and as visible text", () => {
		expect(message.html).toContain(`href="${ESCAPED_LINK}"`);
		// Twice — once inside the anchor, once as the copy-and-paste fallback for a
		// client that strips anchors. Splitting on two occurrences yields three parts.
		expect(message.html.split(ESCAPED_LINK)).toHaveLength(3);
	});
});

describe("invitationEmail", () => {
	const invitation = invitationEmail({
		inviter: INVITER,
		organization: ORGANIZATION,
		to: TO,
		url: LINK,
	});

	it("names the organization and the inviter in the subject", () => {
		expect(invitation.subject).toContain(ORGANIZATION);
		expect(invitation.subject).toContain(INVITER);
	});

	it("names the organization and the inviter in both bodies", () => {
		expect(invitation.text).toContain(ORGANIZATION);
		expect(invitation.text).toContain(INVITER);
		expect(invitation.html).toContain(ORGANIZATION);
		expect(invitation.html).toContain(INVITER);
	});

	it("escapes a name that would otherwise become markup", () => {
		const hostile = invitationEmail({
			inviter: '"><script>alert(1)</script>',
			organization: "Acme & Co",
			to: TO,
			url: LINK,
		});

		expect(hostile.html).not.toContain("<script>");
		expect(hostile.html).toContain("Acme &amp; Co");
	});
});
