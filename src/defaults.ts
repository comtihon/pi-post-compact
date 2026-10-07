/**
 * Default directive table and env-driven runtime configuration.
 *
 * The directive table is what makes `post_compact` optional: a tool call that
 * carries no directive still gets a sensible policy, chosen by tool name. File
 * tools are kept verbatim because their output is usually about to be edited
 * against (and the collapse engine replaces them with a one-line finding after
 * one use); everything else is summarized, since shell/search/MCP output is
 * where the bulk of wasted context comes from.
 */
import { type CompactStyle, type PostCompactDirective, DEFAULT_MIN_CHARS, STYLE_GUIDES } from "./compact.js";

/** Tools whose output is kept verbatim (then collapsed after one use) by default. */
export const EXACT_BY_DEFAULT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "multiedit"]);

/** Default hard ceiling on tool-result text that enters context. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20000;

/** Default floor for collapsing large assistant tool-call arguments (strict `>`). */
export const DEFAULT_ARG_COLLAPSE_MIN_CHARS = 800;

/** Default summary style for tool-result compaction. */
export const DEFAULT_COMPACT_STYLE: CompactStyle = "caveman-one-sentence";

/**
 * The directive applied when the model supplied none.
 *
 * `reason` doubles as the summarizer's focus string, so it names the tool (and
 * the file, for file tools — the collapse engine later asks "what did reading
 * <path> show").
 */
export function defaultDirective(toolName: string, input?: Record<string, unknown>): PostCompactDirective {
	if (EXACT_BY_DEFAULT_TOOLS.has(toolName)) {
		const path = typeof input?.path === "string" ? input.path : undefined;
		return { exact: true, reason: path ? `${toolName} output for ${path}` : `${toolName} output` };
	}
	return { exact: false, reason: `${toolName} output` };
}

export interface ResolveDirectiveOptions {
	/** Directive the model supplied via `post_compact`, if any. Always wins. */
	explicit?: PostCompactDirective;
	toolName: string;
	input?: Record<string, unknown>;
	/** `PI_REQUIRE_DIRECTIVE=1`: no explicit directive → no compaction at all. */
	requireDirective?: boolean;
}

/** Explicit directive → default table (unless directives are required) → none. */
export function resolveDirective(opts: ResolveDirectiveOptions): PostCompactDirective | undefined {
	if (opts.explicit) return opts.explicit;
	if (opts.requireDirective) return undefined;
	return defaultDirective(opts.toolName, opts.input);
}

/**
 * Parse a raw `post_compact` value into a directive, or `undefined` when it is
 * malformed. Accepts the JSON-string form some models emit for nested objects.
 */
export function parseDirective(raw: unknown): PostCompactDirective | undefined {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.exact !== "boolean" || typeof rec.reason !== "string") return undefined;
	return { exact: rec.exact, reason: rec.reason };
}

/** All env-driven settings. Read on demand so a host can change env between runs. */
export interface RuntimeConfig {
	/** `PI_ARTIFACT_ALL_RESULTS` — write every text tool result to `.tool_artifacts/`. */
	artifactAllResults: boolean;
	/** `PI_TOOL_RESULT_MAX_CHARS` — hard head-truncation ceiling. 0 disables. */
	toolResultMaxChars: number;
	/** `PI_REQUIRE_DIRECTIVE` — only compact when the model supplied `post_compact`. */
	requireDirective: boolean;
	/** `PI_COMPACT_STYLE` — summary style for tool-result compaction. */
	compactStyle: CompactStyle;
	/** `PI_COMPACT_MIN_CHARS` — floor below which a result is not summarized. */
	compactMinChars: number;
	/** `PI_COLLAPSE_MIN_CHARS` — floor for collapsing verbatim results / assistant text. */
	collapseMinChars: number;
	/** `PI_ARG_COLLAPSE_MIN_CHARS` — floor (strict `>`) for collapsing tool-call arguments. */
	argCollapseMinChars: number;
	/** `PI_SCHEMA_DIRECTIVE` — add the optional `post_compact` property to outgoing tool schemas. */
	schemaDirective: boolean;
	/** `PI_POST_COMPACT_DEBUG` — emit debug lines (e.g. the cache frontier) to stderr. */
	debug: boolean;
}

type Env = Record<string, string | undefined>;

function numberFromEnv(env: Env, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolFromEnv(env: Env, name: string, fallback: boolean): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (raw === undefined || raw === "") return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

function styleFromEnv(env: Env, name: string, fallback: CompactStyle): CompactStyle {
	const raw = env[name]?.trim();
	return raw && Object.prototype.hasOwnProperty.call(STYLE_GUIDES, raw) ? (raw as CompactStyle) : fallback;
}

export function readRuntimeConfig(env: Env = process.env): RuntimeConfig {
	return {
		artifactAllResults: boolFromEnv(env, "PI_ARTIFACT_ALL_RESULTS", true),
		toolResultMaxChars: numberFromEnv(env, "PI_TOOL_RESULT_MAX_CHARS", DEFAULT_TOOL_RESULT_MAX_CHARS),
		requireDirective: boolFromEnv(env, "PI_REQUIRE_DIRECTIVE", false),
		compactStyle: styleFromEnv(env, "PI_COMPACT_STYLE", DEFAULT_COMPACT_STYLE),
		compactMinChars: numberFromEnv(env, "PI_COMPACT_MIN_CHARS", DEFAULT_MIN_CHARS),
		collapseMinChars: numberFromEnv(env, "PI_COLLAPSE_MIN_CHARS", DEFAULT_MIN_CHARS),
		argCollapseMinChars: numberFromEnv(env, "PI_ARG_COLLAPSE_MIN_CHARS", DEFAULT_ARG_COLLAPSE_MIN_CHARS),
		schemaDirective: boolFromEnv(env, "PI_SCHEMA_DIRECTIVE", true),
		debug: boolFromEnv(env, "PI_POST_COMPACT_DEBUG", false),
	};
}
