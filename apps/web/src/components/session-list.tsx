import { Button } from "@keel/ui/components/button";

/**
 * Structurally typed rather than imported from better-auth, for the same reason
 * `MemberRow` is: this list renders devices, and pinning it to the inferred
 * session type would drag the plugin generics into a presentational component.
 *
 * `token` is here because it is what `revokeSession` takes — the id is not
 * accepted — so the row that offers to end a session has to carry it.
 */
export interface SessionRow {
	createdAt: Date;
	id: string;
	ipAddress?: string | null;
	token: string;
	userAgent?: string | null;
}

/**
 * The tokens worth naming, most specific first, because every one of these
 * strings appears in agents belonging to another browser: Edge and Opera both
 * embed `Chrome`, and Chrome embeds `Safari`. Ordered any other way this
 * reported the wrong product — a headless Chromium listed itself as Safari
 * until `Chrome` was moved ahead of it.
 *
 * Deliberately coarse and deliberately not a user-agent library: the only job
 * here is to let someone recognise which of their own devices a row is, and a
 * full parse would add a dependency to answer a question nobody asked. An
 * unmatched agent falls through to its raw string rather than to "Unknown",
 * because the raw string is still recognisable and "Unknown" is not.
 */
const AGENT_TOKENS = ["Edg", "OPR", "Firefox", "Chrome", "Safari"] as const;
const PLATFORM_TOKENS = [
	"Android",
	"iPhone",
	"iPad",
	"Macintosh",
	"Windows",
	"Linux",
] as const;
/** The three tokens whose raw form nobody would recognise as a product name. */
const AGENT_LABELS: Record<string, string> = {
	Edg: "Edge",
	Macintosh: "macOS",
	OPR: "Opera",
};

function describeDevice(userAgent: string | null | undefined) {
	if (!userAgent) {
		// A session created without a User-Agent header — a script, or a client that
		// strips it. Saying so is more useful than an empty cell.
		return "Unidentified client";
	}

	const browser = AGENT_TOKENS.find((token) => userAgent.includes(token));
	const platform = PLATFORM_TOKENS.find((token) => userAgent.includes(token));

	if (!(browser && platform)) {
		return userAgent;
	}

	return `${AGENT_LABELS[browser] ?? browser} on ${AGENT_LABELS[platform] ?? platform}`;
}

export default function SessionList({
	currentSessionId,
	onRevoke,
	sessions,
}: {
	currentSessionId: string;
	onRevoke: (token: string) => Promise<void>;
	sessions: SessionRow[];
}) {
	return (
		<ul className="divide-y">
			{sessions.map((session) => {
				// Revoking the session rendering this page is signing out, which the
				// user menu already does — and doing it from here would leave the SPA
				// authenticated in memory until the next guard runs.
				const isCurrent = session.id === currentSessionId;

				return (
					<li
						className="flex flex-wrap items-center gap-3 py-3"
						key={session.id}
					>
						<div className="min-w-48 flex-1">
							<p className="font-medium">
								{describeDevice(session.userAgent)}
								{isCurrent ? (
									<span className="text-muted-foreground"> (this device)</span>
								) : null}
							</p>
							<p className="text-muted-foreground text-sm">
								{session.ipAddress || "no recorded address"} — signed in{" "}
								{session.createdAt.toLocaleString()}
							</p>
						</div>

						{isCurrent ? null : (
							<Button
								onClick={() => onRevoke(session.token)}
								size="sm"
								variant="ghost"
							>
								End session
							</Button>
						)}
					</li>
				);
			})}
		</ul>
	);
}
