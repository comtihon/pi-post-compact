/**
 * The `tool_result` pipeline, applied to every text-only tool result:
 *
 *   (a) persist the raw text to `.tool_artifacts/<toolCallId>.txt`
 *   (b) head-truncate at the hard ceiling, naming the artifact path
 *   (c) resolve the directive: explicit `post_compact` → default table
 *   (d) exact → keep (and hand to the collapse engine); otherwise summarize
 *
 * Kept free of the extension API so it can be unit-tested with a fake
 * compactor; index.ts wires it to pi's hooks.
 */
import type {
	CompactOrKeepResult,
	CompactToolResultOptions,
	CompactUsage,
	PostCompactDirective,
} from "./compact.js";
import type { ArtifactStore } from "./artifacts.js";
import { truncateWithNotice } from "./collapse.js";
import { type RuntimeConfig, resolveDirective } from "./defaults.js";

export interface ToolResultContentPart {
	type: string;
	text?: string;
}

export interface ToolResultInput {
	toolCallId: string;
	toolName: string;
	input?: Record<string, unknown>;
	content: readonly ToolResultContentPart[];
}

export interface ProcessToolResultDeps {
	config: RuntimeConfig;
	artifacts?: ArtifactStore;
	/** Directive the model supplied via `post_compact`, if any. */
	explicitDirective?: PostCompactDirective;
	/** Summarizer — `compactOrKeep` bound to the meta-LLM in production. */
	compact: (text: string, opts: CompactToolResultOptions) => Promise<CompactOrKeepResult>;
	/** Called for results kept verbatim under an exact directive. */
	onExact?: (toolCallId: string, reason: string) => void;
	/** Called with meta-LLM usage spent on this result. */
	onUsage?: (usage: CompactUsage) => void;
	log?: (message: string) => void;
}

export interface ProcessToolResultOutcome {
	/** Replacement content, or `undefined` when the result should pass through unchanged. */
	content?: Array<{ type: "text"; text: string }>;
	artifactPath?: string;
	truncated: boolean;
	directive?: PostCompactDirective;
	compacted: boolean;
}

/** Notice appended to a head-truncated result. Names the artifact so the model can `read` the rest. */
export function truncationNotice(shown: number, total: number, artifactPath?: string): string {
	return artifactPath
		? `\n…[truncated: showing first ${shown} of ${total} chars — full output saved to ${artifactPath}; use the read tool on that path if you need the rest]`
		: `\n…[truncated: showing first ${shown} of ${total} chars]`;
}

export async function processToolResult(
	event: ToolResultInput,
	deps: ProcessToolResultDeps,
): Promise<ProcessToolResultOutcome> {
	const unchanged: ProcessToolResultOutcome = { truncated: false, compacted: false };
	const log = deps.log ?? (() => {});

	// Text-only results only: images and mixed content pass through untouched.
	if (event.content.length === 0) return unchanged;
	if (!event.content.every((part) => part.type === "text" && typeof part.text === "string")) return unchanged;

	const full = event.content.map((part) => part.text as string).join("\n");
	if (!full.trim()) return unchanged;

	const { config } = deps;

	// (a) raw text to disk — the escape hatch for truncation and summarization.
	const artifactPath = config.artifactAllResults ? deps.artifacts?.write(event.toolCallId, full) : undefined;

	// (b) hard ceiling, head kept.
	const max = config.toolResultMaxChars;
	const truncated = max > 0 && full.length > max;
	let text = truncated ? truncateWithNotice(full, max, truncationNotice(max, full.length, artifactPath)) : full;
	if (truncated) log(`truncated ${event.toolName} result ${event.toolCallId}: ${full.length} -> ${max} chars`);

	// (c) directive.
	const directive = resolveDirective({
		explicit: deps.explicitDirective,
		toolName: event.toolName,
		input: event.input,
		requireDirective: config.requireDirective,
	});

	const outcome = (compacted: boolean): ProcessToolResultOutcome => ({
		content: text !== full ? [{ type: "text", text }] : undefined,
		artifactPath,
		truncated,
		directive,
		compacted,
	});

	if (!directive) return outcome(false);

	// (d) exact results are kept here and collapsed later, after one use.
	if (directive.exact) {
		deps.onExact?.(event.toolCallId, directive.reason);
		return outcome(false);
	}

	const result = await deps.compact(text, { ...directive, style: config.compactStyle });
	if (result.usage) deps.onUsage?.(result.usage);
	if (!result.changed) return outcome(false);

	text = artifactPath ? `${result.text}\n[full output: ${artifactPath}]` : result.text;
	return outcome(true);
}
