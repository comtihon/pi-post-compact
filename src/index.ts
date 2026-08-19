import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	type CompactOrKeepDeps,
	type PostCompactDirective,
	compactOrKeep,
	DEFAULT_MIN_CHARS,
	resolveMetaLlm,
} from "./compact.js";
import { DEFAULT_ARTIFACT_DIRNAME, createArtifactStore } from "./artifacts.js";
import { ContextCollapseEngine } from "./context-collapse.js";

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

const SYSTEM_PROMPT_ADDON = `
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

Verbatim results do not stay verbatim forever: once you have reasoned over one, it
is replaced by a one-line summary of what it told you, with the full text left on
disk at a path named in that summary. Read that path back if you need the detail again.
`.trimStart();

export default function postCompactExtension(pi: ExtensionAPI) {
	const directives = new Map<string, PostCompactDirective>();
	let configCwd = "";
	let collapse: ContextCollapseEngine | undefined;

	pi.registerFlag("meta_llm", {
		description: "Meta-LLM to use for post-compact summarization (provider/model)",
		type: "string",
	});
	pi.registerFlag("no_context_collapse", {
		description: "Disable retroactive collapse of verbatim results and large tool-call arguments",
		type: "boolean",
	});

	const collapseEnabled = () => pi.getFlag("no_context_collapse") !== true;

	const metaLlm = () =>
		resolveMetaLlm({ flag: pi.getFlag("meta_llm"), cwd: configCwd || undefined });

	const numberFromEnv = (name: string, fallback: number) => {
		const parsed = Number(process.env[name]);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
	};

	pi.on("session_start", async (_event, ctx) => {
		configCwd = ctx.cwd;
		collapse = new ContextCollapseEngine({
			minChars: numberFromEnv("PI_COLLAPSE_MIN_CHARS", DEFAULT_MIN_CHARS),
			maxToolResultChars: numberFromEnv("PI_TOOL_RESULT_MAX_CHARS", 0),
			artifacts: createArtifactStore(join(ctx.cwd, DEFAULT_ARTIFACT_DIRNAME), (m) =>
				console.warn(`[pi-post-compact] ${m}`),
			),
			log: (m) => console.error(`[pi-post-compact] ${m}`),
		});
	});

	pi.on("agent_start", async () => {
		collapse?.startRun();
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT_ADDON}`,
		};
	});

	pi.on("tool_call", async (event) => {
		const input = event.input as Record<string, unknown>;
		const raw = input["post_compact"];
		if (raw === undefined || raw === null) return;

		// Remove from input so the original tool never sees it
		delete input["post_compact"];

		// Validate shape
		if (
			typeof raw === "object" &&
			raw !== null &&
			typeof (raw as Record<string, unknown>)["exact"] === "boolean" &&
			typeof (raw as Record<string, unknown>)["reason"] === "string"
		) {
			const directive = raw as PostCompactDirective;
			directives.set(event.toolCallId, directive);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const directive = directives.get(event.toolCallId);
		directives.delete(event.toolCallId);

		if (!directive) return undefined;

		// exact:true results are kept verbatim here on purpose. They are handed to
		// the collapse engine instead, which replaces them with a one-line finding
		// after the model has actually reasoned over them once — see the `context`
		// handler below.
		if (directive.exact !== false) {
			collapse?.noteExactResult(event.toolCallId, directive.reason);
			return undefined;
		}

		// Skip if any image content present
		const hasImage = event.content.some((part) => part.type === "image");
		if (hasImage) return undefined;

		// Extract text-only content
		const textParts = event.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text);

		if (textParts.length === 0) return undefined;

		// If content is not text-only (mixed), skip
		if (textParts.length !== event.content.length) return undefined;

		const fullText = textParts.join("\n");
		if (!fullText.trim()) return undefined;

		const result = await compactOrKeep(fullText, directive, {
			metaLlm: metaLlm(),
			modelRegistry: ctx.modelRegistry,
			minChars: numberFromEnv("PI_COMPACT_MIN_CHARS", DEFAULT_MIN_CHARS),
			log: (m) => console.error(`[pi-post-compact] ${m}`),
		});

		// result.usage is intentionally discarded here: the pi-coding-agent SDK's
		// ExtensionContext/ExtensionAPI surface (checked against the installed
		// @earendil-works/pi-coding-agent .d.ts) exposes no mechanism for a plugin
		// to report supplementary token usage into the SDK's own session-level
		// accounting — getContextUsage() is read-only and there is no
		// addUsage/reportTokens/recordUsage-style API. This is a hard SDK
		// limitation, not an oversight; the meta-LLM tokens spent on compaction
		// via this native tool_result hook path are invisible to session stats.
		// (A host that intercepts provider HTTP itself can account for them by
		// reading `usage` off the compactOrKeep result.)
		if (!result.changed) return undefined;

		return {
			content: [{ type: "text" as const, text: result.text }],
		};
	});

	// Rewrite the outgoing context before every LLM call. Non-destructive: the
	// hook receives a deep copy, so session history keeps full fidelity and only
	// the wire payload shrinks.
	pi.on("context", async (event, ctx) => {
		if (!collapse || !collapseEnabled()) return undefined;

		const deps: CompactOrKeepDeps = {
			metaLlm: metaLlm(),
			modelRegistry: ctx.modelRegistry,
			minChars: numberFromEnv("PI_COLLAPSE_MIN_CHARS", DEFAULT_MIN_CHARS),
			log: (m) => console.error(`[pi-post-compact] ${m}`),
		};

		const messages = await collapse.transform(
			event.messages as unknown as Array<{ role?: string } & Record<string, unknown>>,
			deps,
		);
		return { messages: messages as unknown as typeof event.messages };
	});
}
