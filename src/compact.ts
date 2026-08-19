import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { complete, getModel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_META_LLM = "anthropic/claude-haiku-4-5";

/** Default floor below which summarizing is not worth an extra LLM round-trip. */
export const DEFAULT_MIN_CHARS = 800;

export interface PostCompactDirective {
	exact: boolean;
	reason: string;
}

export interface PostCompactConfig {
	meta_llm?: string;
}

/**
 * Output-shape constraints appended to the summarization instruction.
 *
 * These exist because the caller previously had no way to influence the
 * summary's *form* — only its focus, via `reason`. Callers worked around that
 * by concatenating style directives onto `reason`, which mixed "what to look
 * for" with "how to write it" in a single field.
 */
export type CompactStyle = "plain" | "caveman" | "one-sentence" | "caveman-one-sentence";

const CAVEMAN_GUIDE =
	"Write in caveman style: no articles (a/an/the), no filler words, short fragments joined into one line. " +
	"Keep exact numbers, names, and technical terms unchanged.";

const ONE_SENTENCE_GUIDE = "Respond with EXACTLY ONE short sentence. Never use more than one sentence.";

export const STYLE_GUIDES: Record<CompactStyle, string> = {
	plain: "",
	caveman: CAVEMAN_GUIDE,
	"one-sentence": ONE_SENTENCE_GUIDE,
	"caveman-one-sentence": `${ONE_SENTENCE_GUIDE} ${CAVEMAN_GUIDE}`,
};

export interface CompactUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface CompactToolResultOptions extends PostCompactDirective {
	/**
	 * Replaces the default "Summarize the following tool output…" instruction
	 * outright. `reason` is then ignored for prompt construction (it stays
	 * meaningful for logging). Use for summaries that answer a question about
	 * the output rather than describing it — see `buildActionSummaryInstruction`.
	 */
	prompt?: string;
	/** Output-shape constraint appended to the instruction. Defaults to "plain". */
	style?: CompactStyle;
}

/**
 * Instruction for collapsing a result the model already read verbatim.
 *
 * Distinct from the default summarize-this-output prompt: it answers "what did
 * I learn" rather than "what does this contain", which compresses far harder
 * because the answer is one fact instead of a description.
 */
export function buildActionSummaryInstruction(reason: string): string {
	return (
		`Answer in ONE short sentence: ${reason}. ` +
		"State only the specific finding — an exact line number, value, or \"not found\" — " +
		"never a general description of the file/output."
	);
}

/** Focus string for collapsing a verbose assistant reasoning turn. */
export const ASSISTANT_CONTENT_REASON =
	"assistant reasoning turn — preserve decisions, findings, chosen approach, and any file paths or values";

export function loadConfig(cwd: string): PostCompactConfig {
	const globalPath = join(getAgentDir(), "post-compact.json");
	const projectPath = join(cwd, ".pi", "post-compact.json");

	let globalConfig: PostCompactConfig = {};
	let projectConfig: PostCompactConfig = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8")) as PostCompactConfig;
		} catch {
			// ignore parse errors
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8")) as PostCompactConfig;
		} catch {
			// ignore parse errors
		}
	}

	return { ...globalConfig, ...projectConfig };
}

export function parseMetaLlm(metaLlm: string): { provider: string; model: string } | undefined {
	const idx = metaLlm.indexOf("/");
	if (idx <= 0) return undefined;
	return {
		provider: metaLlm.slice(0, idx),
		model: metaLlm.slice(idx + 1),
	};
}

export interface ResolveMetaLlmOptions {
	/** Explicit value (e.g. a CLI flag) — wins over everything else. */
	flag?: string | boolean | undefined;
	/** cwd used to find `.pi/post-compact.json`. */
	cwd?: string;
	/** Env to read `META_LLM_PROVIDER` / `META_LLM_MODEL` from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/**
 * Resolve the meta-LLM id, in precedence order: explicit flag →
 * `META_LLM_PROVIDER`/`META_LLM_MODEL` env pair → post-compact.json →
 * `DEFAULT_META_LLM`.
 *
 * Hosts that spawn the agent from a container pass the model through env;
 * interactive pi passes it as a flag. Both need the same fallback chain, so it
 * lives here rather than being duplicated per host.
 */
export function resolveMetaLlm(opts: ResolveMetaLlmOptions = {}): string {
	if (typeof opts.flag === "string" && opts.flag) return opts.flag;

	const env = opts.env ?? process.env;
	if (env.META_LLM_PROVIDER && env.META_LLM_MODEL) {
		return `${env.META_LLM_PROVIDER}/${env.META_LLM_MODEL}`;
	}

	if (opts.cwd !== undefined) {
		const configured = loadConfig(opts.cwd).meta_llm;
		if (configured) return configured;
	}

	return DEFAULT_META_LLM;
}

export interface ModelRegistryLike {
	getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: unknown }>;
}

/**
 * Summarize `text` via the configured meta-LLM, focused on `opts.reason`.
 * Returns `undefined` on any failure or empty summary — never throws
 * ("never break the agent"), matching the original inline tool_result hook
 * behavior this was extracted from.
 */
export async function compactToolResult(
	text: string,
	opts: CompactToolResultOptions,
	metaLlm: string,
	modelRegistry: ModelRegistryLike,
): Promise<{ text: string; usage?: CompactUsage } | undefined> {
	if (opts.exact) return undefined;

	try {
		const parsed = parseMetaLlm(metaLlm);
		if (!parsed) return undefined;

		const model = getModel(parsed.provider as KnownProvider, parsed.model as never);
		if (!model) return undefined;

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;

		const instruction = opts.prompt ?? `Summarize the following tool output concisely. Focus on: ${opts.reason}`;
		const styleGuide = STYLE_GUIDES[opts.style ?? "plain"];

		const summaryPrompt = [
			instruction,
			...(styleGuide ? ["", styleGuide] : []),
			"",
			"Preserve key facts, values, and any errors. Omit irrelevant details.",
			"",
			"<output>",
			text,
			"</output>",
		].join("\n");

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: summaryPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers as never,
			},
		);

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		if (!summary.trim()) return undefined;

		// pi-ai's Usage shape (input/output/totalTokens) differs from the
		// OpenAI-style prompt_tokens/completion_tokens/total_tokens shape callers
		// accumulate in — map it here.
		const usage = response.usage
			? {
					prompt_tokens: response.usage.input,
					completion_tokens: response.usage.output,
					total_tokens: response.usage.totalTokens,
				}
			: undefined;

		return { text: summary, usage };
	} catch {
		// Never break the agent
		return undefined;
	}
}

export type CompactSkipReason =
	| "exact"
	| "below-threshold"
	| "unavailable"
	| "no-shrink"
	| "empty-or-error";

export interface CompactOrKeepResult {
	/** The compacted text, or the original when compaction was skipped or failed. */
	text: string;
	/** True only when `text` differs from the input. */
	changed: boolean;
	/** Meta-LLM tokens spent. The caller must account for these — see note below. */
	usage?: CompactUsage;
	/** Set when the original text was kept, explaining why. */
	skipped?: CompactSkipReason;
}

export interface CompactOrKeepDeps {
	metaLlm: string;
	modelRegistry: ModelRegistryLike | undefined;
	/** Floor below which text is returned unchanged. Defaults to `DEFAULT_MIN_CHARS`. */
	minChars?: number;
	/** Optional trace sink; receives one line per decision. */
	log?: (message: string) => void;
}

/**
 * Gate + compact + guard, in one call: the full "should this be summarized, and
 * is the summary actually an improvement" policy.
 *
 * Never throws and never loses data — every failure path returns the original
 * text with a `skipped` reason. A summary that is not shorter than the input is
 * discarded (`no-shrink`), which happens routinely on already-terse output such
 * as a short `ls` listing.
 *
 * `usage` is returned rather than reported because the pi SDK exposes no way for
 * an extension to add supplementary tokens to session accounting — hosts that
 * can account for it (e.g. one intercepting provider HTTP itself) should.
 */
export async function compactOrKeep(
	text: string,
	opts: CompactToolResultOptions,
	deps: CompactOrKeepDeps,
): Promise<CompactOrKeepResult> {
	const log = deps.log ?? (() => {});
	const minChars = deps.minChars ?? DEFAULT_MIN_CHARS;

	if (opts.exact === true) {
		log(`compaction skipped (exact=true): ${opts.reason}`);
		return { text, changed: false, skipped: "exact" };
	}
	if (text.length < minChars) {
		log(`compaction skipped (${text.length} chars < ${minChars}): ${opts.reason}`);
		return { text, changed: false, skipped: "below-threshold" };
	}
	if (!deps.modelRegistry) {
		log(`compaction unavailable, keeping raw output: ${opts.reason}`);
		return { text, changed: false, skipped: "unavailable" };
	}

	const result = await compactToolResult(text, opts, deps.metaLlm, deps.modelRegistry);
	if (!result?.text) {
		log(`compaction failed, keeping raw output: ${opts.reason}`);
		return { text, changed: false, skipped: "empty-or-error" };
	}
	if (result.text.length >= text.length) {
		log(`compaction did not shrink output (${text.length} -> ${result.text.length} chars), keeping raw: ${opts.reason}`);
		return { text, changed: false, usage: result.usage, skipped: "no-shrink" };
	}

	log(`compacted: ${text.length} -> ${result.text.length} chars (reason: "${opts.reason}")`);
	return { text: result.text, changed: true, usage: result.usage };
}
