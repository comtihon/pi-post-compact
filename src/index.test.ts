// Unit tests for compactToolResult, using Node's built-in test runner.
// No live network calls are made: getModel() is a pure lookup, and every
// path that would reach complete() (the actual LLM call) is short-circuited
// via a mocked modelRegistry.getApiKeyAndHeaders() that never returns ok:true.
import { test } from "node:test";
import assert from "node:assert/strict";

import { compactToolResult, parseMetaLlm, loadConfig } from "./index.js";

test("compactToolResult short-circuits to undefined on exact:true without calling modelRegistry", async () => {
	let called = false;
	const modelRegistry = {
		async getApiKeyAndHeaders() {
			called = true;
			return { ok: true, apiKey: "x" };
		},
	};
	const result = await compactToolResult(
		"some tool output",
		{ exact: true, reason: "irrelevant" },
		"anthropic/claude-haiku-4-5",
		modelRegistry,
	);
	assert.equal(result, undefined);
	assert.equal(called, false, "exact:true must never invoke modelRegistry/complete");
});

test("compactToolResult returns undefined when metaLlm string cannot be parsed (no provider/model separator)", async () => {
	const modelRegistry = {
		async getApiKeyAndHeaders() {
			throw new Error("should not be called");
		},
	};
	const result = await compactToolResult(
		"some tool output",
		{ exact: false, reason: "looking for X" },
		"not-a-valid-meta-llm-string",
		modelRegistry,
	);
	assert.equal(result, undefined);
});

test("compactToolResult returns undefined when auth resolution fails (ok:false)", async () => {
	const modelRegistry = {
		async getApiKeyAndHeaders() {
			return { ok: false };
		},
	};
	const result = await compactToolResult(
		"some tool output",
		{ exact: false, reason: "looking for X" },
		"anthropic/claude-haiku-4-5",
		modelRegistry,
	);
	assert.equal(result, undefined);
});

test("compactToolResult never throws — swallows errors from modelRegistry and returns undefined", async () => {
	const modelRegistry = {
		async getApiKeyAndHeaders() {
			throw new Error("boom");
		},
	};
	await assert.doesNotReject(async () => {
		const result = await compactToolResult(
			"some tool output",
			{ exact: false, reason: "looking for X" },
			"anthropic/claude-haiku-4-5",
			modelRegistry,
		);
		assert.equal(result, undefined);
	});
});

test("parseMetaLlm splits provider/model on first slash", () => {
	assert.deepEqual(parseMetaLlm("anthropic/claude-haiku-4-5"), {
		provider: "anthropic",
		model: "claude-haiku-4-5",
	});
	assert.equal(parseMetaLlm("no-slash-here"), undefined);
});

test("loadConfig returns {} when no config files exist", () => {
	// A cwd that (almost certainly) has no .pi/post-compact.json.
	const config = loadConfig("/tmp/pi-post-compact-test-nonexistent-dir");
	assert.deepEqual(config, {});
});
