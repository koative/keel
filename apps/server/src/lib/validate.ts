import { validationFailed } from "@keel/http/errors";

/**
 * `zValidator` hands its hook Zod 4's core `$ZodError`, not the `ZodError`
 * facade, and the two are not assignable. Typing against the two fields actually
 * consumed keeps this working across either.
 */
type ValidationResult =
	| { success: true }
	| {
			error: {
				issues: readonly { message: string; path: readonly PropertyKey[] }[];
			};
			success: false;
	  };

/**
 * The single translation from a Zod failure to a 422.
 *
 * Passed to every `zValidator` so a rejected body, param or query comes back in
 * the same envelope as every other error. Without it Zod's error reaches
 * `app.onError` carrying no status and degrades to a 500.
 */
export function rejectInvalid(result: ValidationResult) {
	if (result.success) {
		return;
	}

	throw validationFailed(
		result.error.issues
			.map(
				(issue) =>
					`${issue.path.map(String).join(".") || "body"}: ${issue.message}`
			)
			.join("; ")
	);
}
