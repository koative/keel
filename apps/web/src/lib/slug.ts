/**
 * Organization slugs are user-visible and globally unique, so derive them
 * predictably: decompose accents to their base letters, drop the combining
 * marks, then collapse every remaining run of non-alphanumerics into a single
 * hyphen. Trimming happens after the length cap so a truncated slug cannot end
 * on a hyphen.
 */
export function slugify(input: string): string {
	return input
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 48)
		.replace(/^-+|-+$/g, "");
}
