import { Button } from "@keel/ui/components/button";
import { Input } from "@keel/ui/components/input";
import { Label } from "@keel/ui/components/label";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { slugify } from "@/lib/slug";

const schema = z.object({
	name: z.string().min(2, "At least 2 characters"),
	slug: z
		.string()
		.min(2, "At least 2 characters")
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			"Lowercase letters, digits and single hyphens only"
		),
});

export default function CreateOrganizationForm({
	onCreated,
}: {
	onCreated: (organizationId: string) => Promise<void> | void;
}) {
	// Once the user edits the slug themselves, stop deriving it from the name —
	// otherwise the next keystroke in `name` silently overwrites their edit.
	const [slugTouched, setSlugTouched] = useState(false);

	const form = useForm({
		defaultValues: { name: "", slug: "" },
		onSubmit: async ({ value }) => {
			const { data, error } = await authClient.organization.create({
				name: value.name,
				slug: value.slug,
			});

			if (error || !data) {
				toast.error(
					error?.code === "ORGANIZATION_ALREADY_EXISTS"
						? "That short name is already taken"
						: (error?.message ?? "Could not create the organization")
				);
				return;
			}

			await onCreated(data.id);
		},
		validators: { onSubmit: schema },
	});

	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				event.stopPropagation();
				form.handleSubmit();
			}}
		>
			<form.Field name="name">
				{(field) => (
					<div className="space-y-2">
						<Label htmlFor={field.name}>Organization name</Label>
						<Input
							id={field.name}
							name={field.name}
							onBlur={field.handleBlur}
							onChange={(event) => {
								field.handleChange(event.target.value);
								if (!slugTouched) {
									form.setFieldValue("slug", slugify(event.target.value));
								}
							}}
							placeholder="Acme Inc"
							value={field.state.value}
						/>
						{field.state.meta.errors.map((error) => (
							<p className="text-red-500" key={error?.message}>
								{error?.message}
							</p>
						))}
					</div>
				)}
			</form.Field>

			<form.Field name="slug">
				{(field) => (
					<div className="space-y-2">
						<Label htmlFor={field.name}>Short name</Label>
						<Input
							id={field.name}
							name={field.name}
							onBlur={field.handleBlur}
							onChange={(event) => {
								setSlugTouched(true);
								field.handleChange(event.target.value);
							}}
							placeholder="acme-inc"
							value={field.state.value}
						/>
						<p className="text-muted-foreground text-sm">
							Must be unique across all organizations.
						</p>
						{field.state.meta.errors.map((error) => (
							<p className="text-red-500" key={error?.message}>
								{error?.message}
							</p>
						))}
					</div>
				)}
			</form.Field>

			<form.Subscribe
				selector={(state) => ({
					canSubmit: state.canSubmit,
					isSubmitting: state.isSubmitting,
				})}
			>
				{({ canSubmit, isSubmitting }) => (
					<Button
						className="w-full"
						disabled={!canSubmit || isSubmitting}
						type="submit"
					>
						{isSubmitting ? "Creating..." : "Create organization"}
					</Button>
				)}
			</form.Subscribe>
		</form>
	);
}
