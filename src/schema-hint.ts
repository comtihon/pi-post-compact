/**
 * Advertise the `post_compact` directive in every tool's JSON schema on the
 * outgoing provider payload (`before_provider_request`).
 *
 * The system prompt alone is a weak signal; a schema property is where models
 * actually look when filling tool arguments. The property is optional — the
 * default directive table covers calls that omit it — and is wire-only: pi's
 * own TypeBox tool definitions are never touched, and the argument is stripped
 * again at `message_end`, before pi validates the call (see index.ts).
 *
 * Provider payloads share the tool's `parameters` object by reference
 * (openai-completions / openai-responses pass `tool.parameters` straight
 * through), so every schema is cloned before it is changed — mutating it in
 * place would leak the property into pi's own validator.
 */

export const POST_COMPACT_PROPERTY = "post_compact";

/** JSON schema for the optional `post_compact` argument. */
export const POST_COMPACT_SCHEMA = {
	type: "object",
	description:
		"Optional output-compaction directive. Omit to use the default (file tools kept verbatim, other tools summarized). " +
		"exact:true keeps the result verbatim (when you need exact lines/content/error text); exact:false summarizes it. " +
		"reason states what you are looking for and focuses the summary.",
	properties: {
		exact: { type: "boolean", description: "true = keep output verbatim; false = summarize it" },
		reason: { type: "string", description: "What you are looking for in this tool's output" },
	},
	required: ["exact", "reason"],
} as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Return `schema` with `post_compact` added to its properties, or `undefined`
 * when nothing should change (not an object schema, or the property exists).
 * Never adds to `required`; never mutates the input.
 */
export function withPostCompactProperty(schema: unknown): JsonObject | undefined {
	if (!isObject(schema)) return undefined;
	if (schema.type !== undefined && schema.type !== "object") return undefined;
	const properties = isObject(schema.properties) ? schema.properties : {};
	if (Object.prototype.hasOwnProperty.call(properties, POST_COMPACT_PROPERTY)) return undefined;
	return {
		...schema,
		properties: { ...properties, [POST_COMPACT_PROPERTY]: structuredClone(POST_COMPACT_SCHEMA) },
	};
}

/**
 * Add `post_compact` to every tool schema in a provider payload. Handles:
 *
 * - openai-completions: `tools[].function.parameters`
 * - openai-responses:   `tools[].parameters` (with `type: "function"`)
 * - anthropic:          `tools[].input_schema`
 *
 * Tools in strict mode are skipped (strict schemas must list every property in
 * `required`, so an optional one would be rejected). Idempotent. Returns the
 * number of schemas changed; the payload is updated in place (only fresh,
 * per-request tool wrapper objects are touched — schemas are replaced, not
 * mutated).
 */
export function injectPostCompactSchema(payload: unknown): number {
	if (!isObject(payload) || !Array.isArray(payload.tools)) return 0;
	let changed = 0;

	for (const tool of payload.tools as unknown[]) {
		if (!isObject(tool)) continue;

		if (isObject(tool.function)) {
			const fn = tool.function;
			if (fn.strict === true) continue;
			const next = withPostCompactProperty(fn.parameters);
			if (next) {
				tool.function = { ...fn, parameters: next };
				changed++;
			}
			continue;
		}

		if (isObject(tool.input_schema)) {
			const next = withPostCompactProperty(tool.input_schema);
			if (next) {
				tool.input_schema = next;
				changed++;
			}
			continue;
		}

		if (isObject(tool.parameters) && (tool.type === undefined || tool.type === "function")) {
			if (tool.strict === true) continue;
			const next = withPostCompactProperty(tool.parameters);
			if (next) {
				tool.parameters = next;
				changed++;
			}
		}
	}

	return changed;
}
