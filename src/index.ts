import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface PostCompactDirective {
	exact: boolean;
	reason: string;
}

interface PostCompactConfig {
	meta_llm?: string;
}

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
`.trimStart();

function loadConfig(cwd: string): PostCompactConfig {
	const globalPath = join(getAgentDir(), "post-compact.json");
	const projectPath = join(cwd, ".pi", "post-compact.json");

	let globalConfig: PostCompactConfig = {};
	let projectConfig: PostCompactConfig = {};

	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			globalConfig = JSON.parse(content) as PostCompactConfig;
		} catch {
			// ignore parse errors
		}
	}

	if (existsSync(projectPath)) {
		try {
			const content = readFileSync(projectPath, "utf-8");
			projectConfig = JSON.parse(content) as PostCompactConfig;
		} catch {
			// ignore parse errors
		}
	}

	return { ...globalConfig, ...projectConfig };
}

function parseMetaLlm(metaLlm: string): { provider: string; model: string } | undefined {
	const idx = metaLlm.indexOf("/");
	if (idx <= 0) return undefined;
	return {
		provider: metaLlm.slice(0, idx),
		model: metaLlm.slice(idx + 1),
	};
}

export default function postCompactExtension(pi: ExtensionAPI) {
	const directives = new Map<string, PostCompactDirective>();
	let configCwd = "";

	pi.registerFlag("meta_llm", {
		description: "Meta-LLM to use for post-compact summarization (provider/model)",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		configCwd = ctx.cwd;
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

		if (!directive || directive.exact !== false) {
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

		try {
			// Resolve meta-LLM config
			const flagValue = pi.getFlag("meta_llm");
			const config = loadConfig(configCwd);
			const metaLlmStr =
				typeof flagValue === "string" && flagValue
					? flagValue
					: config.meta_llm ?? "anthropic/claude-haiku-4-5";

			const parsed = parseMetaLlm(metaLlmStr);
			if (!parsed) return undefined;

			const model = getModel(parsed.provider as KnownProvider, parsed.model as never);
			if (!model) return undefined;

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;

			const summaryPrompt = [
				`Summarize the following tool output concisely. Focus on: ${directive.reason}`,
				"",
				"Preserve key facts, values, and any errors. Omit irrelevant details.",
				"",
				"<output>",
				fullText,
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
					headers: auth.headers,
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) return undefined;

			return {
				content: [{ type: "text" as const, text: summary }],
			};
		} catch {
			// Never break the agent
			return undefined;
		}
	});
}
