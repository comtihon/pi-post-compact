// Wiring tests for the extension entry point, driven through a fake ExtensionAPI.
// No network: ctx.modelRegistry is undefined, so compaction is "unavailable".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postCompactExtension, { STATS_EVENT } from "./index.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const emitted: Array<[string, unknown]> = [];
	const pi = {
		on(name: string, fn: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		events: {
			emit(channel: string, data: unknown) {
				emitted.push([channel, data]);
			},
			on() {
				return () => {};
			},
		},
	};
	postCompactExtension(pi as never);
	const cwd = mkdtempSync(join(tmpdir(), "pc-ext-"));
	const ctx = { cwd, modelRegistry: undefined };
	const fire = async (name: string, event: any) => {
		let last: any;
		for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
		return last;
	};
	return { fire, emitted, cwd };
}

const ENV_KEYS = ["PI_SCHEMA_DIRECTIVE", "PI_TOOL_RESULT_MAX_CHARS", "PI_REQUIRE_DIRECTIVE"];
function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
	return async () => {
		const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		Object.assign(process.env, env);
		try {
			await fn();
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};
}

test("message_end strips post_compact from tool calls before validation and records it", async () => {
	const { fire, cwd } = fakePi();
	await fire("session_start", {});
	const block = {
		type: "toolCall",
		id: "c1",
		name: "edit",
		arguments: { path: "a.ts", edits: [], post_compact: { exact: false, reason: "why" } },
	};
	await fire("message_end", { message: { role: "assistant", content: [block] } });
	assert.deepEqual(block.arguments, { path: "a.ts", edits: [] });

	// The recorded directive (exact:false) is applied at tool_result: with no
	// meta-LLM available the text is kept, but the artifact is still written.
	const out = await fire("tool_result", {
		toolCallId: "c1",
		toolName: "edit",
		input: block.arguments,
		content: [{ type: "text", text: "ok" }],
	});
	assert.equal(out, undefined);
	assert.equal(readFileSync(join(cwd, ".tool_artifacts", "c1.txt"), "utf-8"), "ok");
});

test("tool_call strips post_compact as a fallback", async () => {
	const { fire } = fakePi();
	const input: Record<string, unknown> = { command: "ls", post_compact: { exact: true, reason: "r" } };
	await fire("tool_call", { toolCallId: "c2", toolName: "bash", input });
	assert.deepEqual(input, { command: "ls" });
});

test(
	"tool_result truncates at the default ceiling and names the artifact",
	withEnv({}, async () => {
		const { fire, cwd } = fakePi();
		await fire("session_start", {});
		const out = await fire("tool_result", {
			toolCallId: "big",
			toolName: "bash",
			input: { command: "cat" },
			content: [{ type: "text", text: "b".repeat(30000) }],
		});
		const text = out?.content?.[0]?.text as string;
		assert.ok(text.startsWith("b".repeat(20000)));
		assert.ok(text.includes(join(cwd, ".tool_artifacts", "big.txt")));
	}),
);

test(
	"before_provider_request injects the schema hint by default",
	withEnv({}, async () => {
		const { fire } = fakePi();
		const payload = { tools: [{ name: "bash", input_schema: { type: "object", properties: {} } }] };
		const out = await fire("before_provider_request", { payload });
		assert.equal(out, payload);
		assert.ok((payload.tools[0]?.input_schema.properties as Record<string, unknown>).post_compact);
	}),
);

test(
	"PI_SCHEMA_DIRECTIVE=0 disables the schema hint",
	withEnv({ PI_SCHEMA_DIRECTIVE: "0" }, async () => {
		const { fire } = fakePi();
		const payload = { tools: [{ name: "bash", input_schema: { type: "object", properties: {} } }] };
		assert.equal(await fire("before_provider_request", { payload }), undefined);
		assert.deepEqual(payload.tools[0]?.input_schema.properties, {});
	}),
);

test(
	"the system prompt describes optional directives by default and required ones under PI_REQUIRE_DIRECTIVE",
	async () => {
		const { fire } = fakePi();
		await withEnv({}, async () => {
			const out = await fire("before_agent_start", { systemPrompt: "BASE" });
			assert.match(out.systemPrompt, /optional `post_compact`/);
		})();
		await withEnv({ PI_REQUIRE_DIRECTIVE: "1" }, async () => {
			const out = await fire("before_agent_start", { systemPrompt: "BASE" });
			assert.match(out.systemPrompt, /\(REQUIRED\)/);
		})();
	},
);

test("agent_end emits post-compact:stats with collapseStats and metaUsage", async () => {
	const { fire, emitted } = fakePi();
	await fire("session_start", {});
	await fire("agent_start", {});
	await fire("context", { messages: [{ role: "user", content: "hi" }] });
	await fire("agent_end", { messages: [] });

	assert.equal(emitted.length, 1);
	const [channel, data] = emitted[0] as [string, any];
	assert.equal(channel, STATS_EVENT);
	assert.equal(channel, "post-compact:stats");
	assert.equal(data.collapseStats.roundTrip, 1);
	assert.equal(data.collapseStats.cacheFrontier, 1);
	assert.deepEqual(data.metaUsage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});
