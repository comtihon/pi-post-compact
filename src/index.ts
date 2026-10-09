import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	type CompactOrKeepDeps,
	type CompactUsage,
	type PostCompactDirective,
	compactOrKeep,
	resolveMetaLlm,
} from "./compact.js";
import { type ArtifactStore, DEFAULT_ARTIFACT_DIRNAME, createArtifactStore } from "./artifacts.js";
import { ContextCollapseEngine, type ContextCollapseStats } from "./context-collapse.js";
import { parseDirective, readRuntimeConfig } from "./defaults.js";
import { injectPostCompactSchema, POST_COMPACT_PROPERTY } from "./schema-hint.js";
import { processToolResult } from "./tool-result.js";

export {
	ASSISTANT_CONTENT_REASON,
	buildActionSummaryInstruction,
	compactOrKeep,
	compactToolResult,
	DEFAULT_META_LLM,
	DEFAULT_MIN_CHARS,
	loadConfig,
	parseMetaLlm,
	resolveMetaLlm,
	STYLE_GUIDES,
} from "./compact.js";
export type {
	CompactOrKeepDeps,
	CompactOrKeepResult,
	CompactSkipReason,
	CompactStyle,
	CompactToolResultOptions,
	CompactUsage,
	ModelRegistryLike,
	PostCompactConfig,
	PostCompactDirective,
} from "./compact.js";

export {
	cacheFrontierIndex,
	CollapseTracker,
	DEFAULT_COLLAPSE_DELAY,
	summarizeToolCallArgs,
	truncateWithNotice,
} from "./collapse.js";
export type { CollapseEntry } from "./collapse.js";

export {
	collapseStub,
	createArtifactStore,
	DEFAULT_ARTIFACT_DIRNAME,
	sanitizeArtifactId,
} from "./artifacts.js";
export type { ArtifactStore } from "./artifacts.js";

export { ContextCollapseEngine } from "./context-collapse.js";
export type { ContextCollapseOptions, ContextCollapseStats } from "./context-collapse.js";

export {
	DEFAULT_ARG_COLLAPSE_MIN_CHARS,
	DEFAULT_COMPACT_STYLE,
	DEFAULT_TOOL_RESULT_MAX_CHARS,
	defaultDirective,
	EXACT_BY_DEFAULT_TOOLS,
	parseDirective,
	readRuntimeConfig,
	resolveDirective,
} from "./defaults.js";
export type { ResolveDirectiveOptions, RuntimeConfig } from "./defaults.js";

export {
	injectPostCompactSchema,
	POST_COMPACT_PROPERTY,
	POST_COMPACT_SCHEMA,
	withPostCompactProperty,
} from "./schema-hint.js";

export { processToolResult, truncationNotice } from "./tool-result.js";
export type {
	ProcessToolResultDeps,
	ProcessToolResultOutcome,
	ToolResultInput,
} from "./tool-result.js";

/** Event-bus channel carrying per-run stats, emitted at `agent_end`. */
export const STATS_EVENT = "post-compact:stats";

export interface PostCompactStatsEvent {
	/** Collapse-engine stats (session-cumulative counters), or undefined before session_start. */
	collapseStats: ContextCollapseStats | undefined;
	/**
	 * Meta-LLM tokens spent during this agent run, on tool-result compaction and
	 * context collapse combined. Not reflected in pi's session stats — no
	 * extension API exists to add usage there.
	 */
	metaUsage: CompactUsage;
}

/** System-prompt block used under `PI_REQUIRE_DIRECTIVE=1` (directive-only mode). */
const REQUIRED_DIRECTIVE_ADDON = `
## Tool Result Compaction (REQUIRED)

For EVERY tool call except edit, write, and multiedit, you MUST include a \`post_compact\` field:
- \`post_compact.exact: false\` — summarise the result (DEFAULT — use unless you have a specific reason for verbatim output)
- \`post_compact.exact: true\` — keep verbatim output (only when you need exact line numbers, content to diff/edit, or precise error text)
- \`post_compact.reason: string\` — REQUIRED; describe what you are looking for in this tool call

Omitting \`post_compact\` is only permitted for edit, write, and multiedit tools.

Examples:
- \`semble search "auth flow"\` → \`post_compact: { exact: false, reason: "looking for authentication entry points" }\`
- \`bash\` reading a file you will edit → \`post_compact: { exact: true, reason: "need exact content to produce an edit" }\`
- \`jira_get_issue\` → \`post_compact: { exact: false, reason: "need ticket description and acceptance criteria" }\`
`.trimStart();

/** System-prompt block used by default, where `post_compact` is optional. */
const OPTIONAL_DIRECTIVE_ADDON = `
## Tool Result Compaction

Tool results are compacted before you see them:
- read, write, edit and multiedit results are kept verbatim;
- every other tool's result (bash, grep, find, ls, mcp, ...) is summarised.

To override, add an optional \`post_compact\` field to any tool call:
- \`post_compact: { exact: true, reason: "..." }\` — keep the output verbatim (when you need exact line numbers, content to edit, or precise error text)
- \`post_compact: { exact: false, reason: "..." }\` — summarise it, focused on \`reason\` (what you are looking for)

Giving a \`reason\` makes summaries far more useful, e.g.
\`bash\` → \`post_compact: { exact: false, reason: "which tests fail and why" }\`.

Very long outputs are truncated, and summarised outputs are shortened; in both cases the full
text is saved to a file whose path is shown — use the read tool on it if you need the rest.
`.trimStart();

const COLLAPSE_NOTE = `
Verbatim results do not stay verbatim forever: once you have reasoned over one, it
is replaced by a one-line summary of what it told you, with the full text left on
disk at a path named in that summary. Read that path back if you need the detail again.
`.trimStart();

const LOG_PREFIX = "[pi-post-compact]";

function emptyUsage(): CompactUsage {
	return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function addUsage(acc: CompactUsage, usage: CompactUsage | undefined): void {
	if (!usage) return;
	acc.prompt_tokens += usage.prompt_tokens || 0;
	acc.completion_tokens += usage.completion_tokens || 0;
	acc.total_tokens += usage.total_tokens || 0;
}

/**
 * Pull `post_compact` out of a tool-call argument object: records the directive
 * (when well-formed) and deletes the key so the tool never sees it.
 */
function takeDirective(
	args: unknown,
	toolCallId: string,
	directives: Map<string, PostCompactDirective>,
): void {
	if (!args || typeof args !== "object") return;
	const rec = args as Record<string, unknown>;
	if (!Object.prototype.hasOwnProperty.call(rec, POST_COMPACT_PROPERTY)) return;
	const raw = rec[POST_COMPACT_PROPERTY];
	delete rec[POST_COMPACT_PROPERTY];
	const directive = parseDirective(raw);
	if (directive) directives.set(toolCallId, directive);
}

export default function postCompactExtension(pi: ExtensionAPI) {
	const directives = new Map<string, PostCompactDirective>();
	let configCwd = "";
	let collapse: ContextCollapseEngine | undefined;
	let artifacts: ArtifactStore | undefined;

	// Per-run meta-LLM usage: tool_result compaction, plus the collapse engine's
	// spend since agent_start (its own counter is session-cumulative).
	let runCompactUsage = emptyUsage();
	let collapseUsageAtStart = emptyUsage();

	pi.registerFlag("meta_llm", {
		description: "Meta-LLM to use for post-compact summarization (provider/model)",
		type: "string",
	});
	pi.registerFlag("no_context_collapse", {
		description: "Disable retroactive collapse of verbatim results and large tool-call arguments",
		type: "boolean",
	});

	const collapseEnabled = () => pi.getFlag("no_context_collapse") !== true;
	const config = () => readRuntimeConfig(process.env);

	const metaLlm = () =>
		resolveMetaLlm({ flag: pi.getFlag("meta_llm"), cwd: configCwd || undefined });

	const log = (m: string) => console.error(`${LOG_PREFIX} ${m}`);
	const debug = (m: string) => {
		if (config().debug) console.error(`${LOG_PREFIX} [debug] ${m}`);
	};

	const artifactStore = (cwd: string) => {
		artifacts ??= createArtifactStore(join(cwd, DEFAULT_ARTIFACT_DIRNAME), (m) =>
			console.warn(`${LOG_PREFIX} ${m}`),
		);
		return artifacts;
	};

	pi.on("session_start", async (_event, ctx) => {
		configCwd = ctx.cwd;
		artifacts = undefined;
		const cfg = config();
		collapse = new ContextCollapseEngine({
			minChars: cfg.collapseMinChars,
			argMinChars: cfg.argCollapseMinChars,
			// The hard ceiling is applied once, at tool_result (with an artifact-
			// naming notice); re-applying it here would cut that notice off.
			maxToolResultChars: 0,
			artifacts: artifactStore(ctx.cwd),
			log,
		});
	});

	pi.on("agent_start", async () => {
		collapse?.startRun();
		runCompactUsage = emptyUsage();
		collapseUsageAtStart = collapse?.getStats().usage ?? emptyUsage();
	});

	pi.on("agent_end", async () => {
		const collapseStats = collapse?.getStats();
		const metaUsage = { ...runCompactUsage };
		if (collapseStats) {
			addUsage(metaUsage, {
				prompt_tokens: collapseStats.usage.prompt_tokens - collapseUsageAtStart.prompt_tokens,
				completion_tokens: collapseStats.usage.completion_tokens - collapseUsageAtStart.completion_tokens,
				total_tokens: collapseStats.usage.total_tokens - collapseUsageAtStart.total_tokens,
			});
		}
		const payload: PostCompactStatsEvent = { collapseStats, metaUsage };
		pi.events.emit(STATS_EVENT, payload);
	});

	pi.on("before_agent_start", async (event) => {
		const addon = config().requireDirective ? REQUIRED_DIRECTIVE_ADDON : OPTIONAL_DIRECTIVE_ADDON;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${addon}\n${COLLAPSE_NOTE}`,
		};
	});

	// Advertise post_compact in every tool schema on the wire.
	pi.on("before_provider_request", async (event) => {
		if (!config().schemaDirective) return undefined;
		const changed = injectPostCompactSchema(event.payload);
		return changed > 0 ? event.payload : undefined;
	});

	// Strip post_compact from the finalized assistant message, BEFORE pi
	// validates tool arguments. Validation runs ahead of the tool_call hook, and
	// tools whose schema sets additionalProperties:false (e.g. `edit`) would
	// reject the extra argument. The message object is the one the agent loop
	// executes from, so the in-place delete is what the tool sees.
	pi.on("message_end", async (event) => {
		const msg = event.message as unknown as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
		for (const block of msg.content as Array<Record<string, unknown>>) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			takeDirective(block.arguments, block.id, directives);
		}
		return undefined;
	});

	// Fallback for paths that bypass message_end: strip it here too.
	pi.on("tool_call", async (event) => {
		takeDirective(event.input, event.toolCallId, directives);
	});

	pi.on("tool_result", async (event, ctx) => {
		const explicitDirective = directives.get(event.toolCallId);
		directives.delete(event.toolCallId);
		const cfg = config();

		const outcome = await processToolResult(
			{
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: event.input,
				content: event.content,
			},
			{
				config: cfg,
				artifacts: artifactStore(ctx.cwd || configCwd),
				explicitDirective,
				compact: (text, opts) =>
					compactOrKeep(text, opts, {
						metaLlm: metaLlm(),
						modelRegistry: ctx.modelRegistry,
						minChars: cfg.compactMinChars,
						log,
					}),
				// exact results stay verbatim here; the collapse engine replaces them
				// with a one-line finding once the model has reasoned over them.
				onExact: (id, reason) => collapse?.noteExactResult(id, reason),
				// Usage cannot reach pi's session stats (no extension API for it);
				// it is reported on the post-compact:stats event instead.
				onUsage: (usage) => addUsage(runCompactUsage, usage),
				log,
			},
		);

		return outcome.content ? { content: outcome.content } : undefined;
	});

	// Rewrite the outgoing context before every LLM call. Non-destructive: the
	// hook receives a deep copy, so session history keeps full fidelity and only
	// the wire payload shrinks.
	pi.on("context", async (event, ctx) => {
		if (!collapse || !collapseEnabled()) return undefined;

		const deps: CompactOrKeepDeps = {
			metaLlm: metaLlm(),
			modelRegistry: ctx.modelRegistry,
			minChars: config().collapseMinChars,
			log,
		};

		const messages = await collapse.transform(
			event.messages as unknown as Array<{ role?: string } & Record<string, unknown>>,
			deps,
		);
		debug(`cache frontier: ${collapse.getStats().cacheFrontier} of ${messages.length} messages stable`);
		return { messages: messages as unknown as typeof event.messages };
	});
}
