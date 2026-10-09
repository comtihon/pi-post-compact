/**
 * Retroactive collapse for native pi sessions, driven by the `context` hook.
 *
 * `context` fires before every LLM call with a deep copy of the message list and
 * replaces whatever it returns. That makes it the right seam for this: the
 * session's own history — and therefore `/compact`, resume, and the transcript —
 * keeps full fidelity, while only the outgoing payload shrinks.
 *
 * The deep copy has one consequence that shapes everything below: mutations do
 * not persist, so every summary must be cached by a stable id or it would be
 * recomputed (and re-billed) on every single request.
 */
import {
	ASSISTANT_CONTENT_REASON,
	type CompactOrKeepDeps,
	type CompactUsage,
	buildActionSummaryInstruction,
	compactOrKeep,
	DEFAULT_MIN_CHARS,
} from "./compact.js";
import { type ArtifactStore, collapseStub } from "./artifacts.js";
import { cacheFrontierIndex, summarizeToolCallArgs, truncateWithNotice } from "./collapse.js";
import { DEFAULT_ARG_COLLAPSE_MIN_CHARS } from "./defaults.js";

/** Minimal structural views of the pi message shapes this engine touches. */
interface TextBlock {
	type: "text";
	text: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
interface AnyBlock {
	type: string;
	[key: string]: unknown;
}
interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName?: string;
	content: AnyBlock[];
}
interface AssistantLike {
	role: "assistant";
	content: AnyBlock[];
	responseId?: string;
	timestamp?: number;
}
type MessageLike = { role?: string } & Record<string, unknown>;

function isToolResult(msg: MessageLike): msg is ToolResultLike & MessageLike {
	return msg.role === "toolResult" && Array.isArray((msg as unknown as ToolResultLike).content);
}
function isAssistant(msg: MessageLike): msg is AssistantLike & MessageLike {
	return msg.role === "assistant" && Array.isArray((msg as unknown as AssistantLike).content);
}
function isTextBlock(block: AnyBlock): block is TextBlock & AnyBlock {
	return block.type === "text" && typeof block.text === "string";
}
function isToolCallBlock(block: AnyBlock): block is ToolCallBlock & AnyBlock {
	return block.type === "toolCall" && typeof block.id === "string";
}

/**
 * Stable identity for an assistant message across `context` invocations.
 *
 * Unlike tool results, assistant messages carry no id of their own, so identity
 * is derived from the provider response id when present and the timestamp
 * otherwise. Both survive the deep copy; the index disambiguates the rare case
 * of two messages sharing a timestamp.
 */
function assistantKey(msg: AssistantLike, index: number): string {
	return `asst-${msg.responseId ?? msg.timestamp ?? "t"}-${index}`;
}

export interface ContextCollapseOptions {
	/** Text shorter than this is left alone. Defaults to `DEFAULT_MIN_CHARS`. */
	minChars?: number;
	/**
	 * Tool-call arguments are collapsed only when their serialized JSON is
	 * strictly longer than this. Separate from `minChars` because argument
	 * collapse is lexical (no LLM call), so it is worth doing at a different
	 * size than an LLM summary. Defaults to `DEFAULT_ARG_COLLAPSE_MIN_CHARS`.
	 */
	argMinChars?: number;
	/** Hard ceiling applied to any tool-result text that survives collapse. 0 disables. */
	maxToolResultChars?: number;
	/** Where displaced originals are written so the model can read them back. */
	artifacts?: ArtifactStore;
	log?: (message: string) => void;
}

export interface ContextCollapseStats {
	roundTrip: number;
	collapsedToolResults: number;
	collapsedToolCallArgs: number;
	collapsedAssistantContent: number;
	truncatedToolResults: number;
	/** Meta-LLM tokens spent this run. Never reaches session accounting — see compactOrKeep. */
	usage: CompactUsage;
	/** First message index still subject to collapse; everything before it is cacheable. */
	cacheFrontier: number;
}

/**
 * Stateful collapse engine. One instance per session.
 *
 * Round-trips are counted per LLM call, and each candidate rides verbatim for a
 * bounded number of them before being replaced:
 *
 * - a tool result the model asked to keep verbatim (`post_compact.exact: true`)
 *   is collapsed to a one-sentence *finding* once a later round-trip begins;
 * - large tool-call arguments and large assistant text are collapsed one further
 *   round-trip out, because arguments created in round *r* only execute in
 *   *r+1*, so rewriting them any earlier would change what runs.
 */
export class ContextCollapseEngine {
	private roundTrip = 0;

	/** id → round-trip it was first seen in. */
	private readonly firstSeen = new Map<string, number>();
	/** id → cached replacement text, so a summary is paid for exactly once. */
	private readonly summaries = new Map<string, string>();
	/** toolCallId → focus string, captured from an `exact: true` directive. */
	private readonly exactReasons = new Map<string, string>();
	/** ids still inside their verbatim window, for the cache-frontier report. */
	private pendingIds = new Set<string>();

	/** ids awaiting collapse as of the last transform, exposed for diagnostics. */
	getPendingIds(): string[] {
		return [...this.pendingIds];
	}

	private readonly stats: ContextCollapseStats = {
		roundTrip: 0,
		collapsedToolResults: 0,
		collapsedToolCallArgs: 0,
		collapsedAssistantContent: 0,
		truncatedToolResults: 0,
		usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		cacheFrontier: 0,
	};

	constructor(private readonly options: ContextCollapseOptions = {}) {}

	/** Record that a tool result was produced under an `exact: true` directive. */
	noteExactResult(toolCallId: string, reason: string): void {
		this.exactReasons.set(toolCallId, reason);
	}

	/** Reset per-run counters. Call on `agent_start`. */
	startRun(): void {
		this.roundTrip = 0;
	}

	getStats(): ContextCollapseStats {
		return { ...this.stats, usage: { ...this.stats.usage } };
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private addUsage(usage: CompactUsage | undefined): void {
		if (!usage) return;
		this.stats.usage.prompt_tokens += usage.prompt_tokens || 0;
		this.stats.usage.completion_tokens += usage.completion_tokens || 0;
		this.stats.usage.total_tokens += usage.total_tokens || 0;
	}

	/** True once `id`'s verbatim window has closed. */
	private isDue(id: string, delay: number): boolean {
		const created = this.firstSeen.get(id);
		return created !== undefined && this.roundTrip > created + delay;
	}

	private seen(id: string): void {
		if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.roundTrip);
	}

	/**
	 * Summarize once, then serve from cache forever.
	 *
	 * A cache miss costs an LLM call inside the request path, which is the same
	 * price paid by compaction at `tool_result`; a cache hit costs nothing, which
	 * is what makes per-request rewriting affordable at all.
	 */
	private async summarize(
		id: string,
		text: string,
		compactOpts: { reason: string; prompt?: string },
		deps: CompactOrKeepDeps,
	): Promise<string | undefined> {
		const cached = this.summaries.get(id);
		if (cached !== undefined) return cached;

		const result = await compactOrKeep(
			text,
			{ exact: false, reason: compactOpts.reason, prompt: compactOpts.prompt, style: "caveman-one-sentence" },
			deps,
		);
		this.addUsage(result.usage);
		if (!result.changed) return undefined;

		this.summaries.set(id, result.text);
		return result.text;
	}

	/**
	 * Rewrite `messages` for the outgoing request. Returns the same array,
	 * mutated in place — safe because the `context` hook hands over a deep copy.
	 *
	 * Never throws: `transformContext`'s contract requires a usable message list,
	 * so a failure here must degrade to the uncollapsed input rather than abort
	 * the turn.
	 */
	async transform(messages: MessageLike[], deps: CompactOrKeepDeps): Promise<MessageLike[]> {
		this.roundTrip++;
		this.stats.roundTrip = this.roundTrip;

		const minChars = this.options.minChars ?? DEFAULT_MIN_CHARS;
		const argMinChars = this.options.argMinChars ?? DEFAULT_ARG_COLLAPSE_MIN_CHARS;
		const maxChars = this.options.maxToolResultChars ?? 0;
		const artifacts = this.options.artifacts;
		const pending = new Set<string>();

		try {
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i] as MessageLike;

				if (isToolResult(msg)) {
					await this.collapseToolResult(msg, { minChars, maxChars, artifacts, deps, pending });
					continue;
				}

				if (isAssistant(msg)) {
					const key = assistantKey(msg, i);
					await this.collapseAssistantContent(msg, key, { minChars, artifacts, deps, pending });
					await this.collapseToolCallArgs(msg, { argMinChars, artifacts, deps, pending });
				}
			}
		} catch (err) {
			this.log(`collapse aborted, sending context unchanged: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.pendingIds = pending;
		this.stats.cacheFrontier = cacheFrontierIndex(messages, (m, i) => messageIsPending(m, i, pending));
		return messages;
	}

	private async collapseToolResult(
		msg: ToolResultLike & MessageLike,
		ctx: {
			minChars: number;
			maxChars: number;
			artifacts: ArtifactStore | undefined;
			deps: CompactOrKeepDeps;
			pending: Set<string>;
		},
	): Promise<void> {
		// Only results the model explicitly kept verbatim are candidates; results
		// it let be summarized were already handled destructively at `tool_result`.
		const reason = this.exactReasons.get(msg.toolCallId);
		if (reason === undefined) return;

		if (msg.content.some((block) => block.type === "image")) return;
		const textBlocks = msg.content.filter(isTextBlock);
		if (textBlocks.length === 0 || textBlocks.length !== msg.content.length) return;

		const full = textBlocks.map((b) => b.text).join("\n");
		if (!full.trim() || full.length < ctx.minChars) return;

		const id = `tr-${msg.toolCallId}`;
		this.seen(id);

		if (!this.isDue(id, 0)) {
			ctx.pending.add(msg.toolCallId);
			// Still inside the verbatim window; only the hard ceiling applies.
			this.applyCeiling(msg, textBlocks, full, ctx.maxChars);
			return;
		}

		const summary = await this.summarize(
			id,
			full,
			{ reason, prompt: buildActionSummaryInstruction(reason) },
			ctx.deps,
		);
		if (summary === undefined) {
			this.applyCeiling(msg, textBlocks, full, ctx.maxChars);
			return;
		}

		const path = ctx.artifacts?.write(`${msg.toolCallId}-result`, full);
		msg.content = [{ type: "text", text: collapseStub(summary, path) } as AnyBlock];
		this.stats.collapsedToolResults++;
		this.log(`collapsed tool result ${msg.toolCallId} to action summary (reason: "${reason}")`);
	}

	private applyCeiling(
		msg: ToolResultLike & MessageLike,
		textBlocks: (TextBlock & AnyBlock)[],
		full: string,
		maxChars: number,
	): void {
		if (maxChars <= 0 || full.length <= maxChars) return;
		msg.content = [{ type: "text", text: truncateWithNotice(full, maxChars) } as AnyBlock];
		this.stats.truncatedToolResults++;
	}

	private async collapseAssistantContent(
		msg: AssistantLike & MessageLike,
		key: string,
		ctx: {
			minChars: number;
			artifacts: ArtifactStore | undefined;
			deps: CompactOrKeepDeps;
			pending: Set<string>;
		},
	): Promise<void> {
		const textBlocks = msg.content.filter(isTextBlock);
		if (textBlocks.length === 0) return;

		const full = textBlocks.map((b) => b.text).join("\n");
		if (full.length <= ctx.minChars) return;

		this.seen(key);
		if (!this.isDue(key, 1)) {
			ctx.pending.add(key);
			return;
		}

		const summary = await this.summarize(key, full, { reason: ASSISTANT_CONTENT_REASON }, ctx.deps);
		if (summary === undefined) return;

		const path = ctx.artifacts?.write(`${key}-content`, full);
		const stub = collapseStub(summary, path);
		// Replace only the text blocks; thinking and toolCall blocks must survive
		// intact or the provider rejects the message as an orphaned tool call.
		const first = msg.content.findIndex(isTextBlock);
		msg.content = msg.content.filter((b) => !isTextBlock(b));
		msg.content.splice(Math.max(first, 0), 0, { type: "text", text: stub } as AnyBlock);
		this.stats.collapsedAssistantContent++;
		this.log(`collapsed assistant content ${key} (${full.length} -> ${stub.length} chars)`);
	}

	private async collapseToolCallArgs(
		msg: AssistantLike & MessageLike,
		ctx: {
			argMinChars: number;
			artifacts: ArtifactStore | undefined;
			deps: CompactOrKeepDeps;
			pending: Set<string>;
		},
	): Promise<void> {
		for (const block of msg.content) {
			if (!isToolCallBlock(block)) continue;

			const serialized = JSON.stringify(block.arguments ?? {});
			if (serialized.length <= ctx.argMinChars) continue;

			const id = `args-${block.id}`;
			this.seen(id);
			if (!this.isDue(id, 1)) {
				ctx.pending.add(block.id);
				continue;
			}
			if (this.summaries.has(id) && block.arguments?.collapsed === true) continue;

			const summary = summarizeToolCallArgs(block.name, serialized);
			const path = ctx.artifacts?.write(`${block.id}-args`, serialized);
			this.summaries.set(id, summary);
			block.arguments = path
				? { collapsed: true, summary, artifact_path: path }
				: { collapsed: true, summary };
			this.stats.collapsedToolCallArgs++;
			this.log(`collapsed tool-call args ${block.id}: ${summary}`);
		}
	}
}

/**
 * Whether `msg` still holds content awaiting collapse, and therefore may still
 * be rewritten on a later request.
 */
function messageIsPending(msg: MessageLike, index: number, pending: Set<string>): boolean {
	if (isToolResult(msg)) return pending.has(msg.toolCallId);
	if (isAssistant(msg)) {
		if (pending.has(assistantKey(msg, index))) return true;
		for (const block of msg.content) {
			if (isToolCallBlock(block) && pending.has(block.id)) return true;
		}
	}
	return false;
}
