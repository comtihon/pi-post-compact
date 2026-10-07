import { test } from "node:test";
import assert from "node:assert/strict";

import { injectPostCompactSchema, POST_COMPACT_SCHEMA, withPostCompactProperty } from "./schema-hint.js";

type Rec = Record<string, any>;

const baseSchema = () => ({
	type: "object",
	properties: { command: { type: "string" } },
	required: ["command"],
});

test("openai-completions: tools[].function.parameters gets post_compact", () => {
	const shared = baseSchema();
	const payload: Rec = { tools: [{ type: "function", function: { name: "bash", parameters: shared } }] };
	assert.equal(injectPostCompactSchema(payload), 1);
	const params = payload.tools[0].function.parameters;
	assert.deepEqual(params.properties.post_compact, POST_COMPACT_SCHEMA);
	assert.deepEqual(params.required, ["command"], "post_compact must never become required");
	assert.equal(shared.properties.hasOwnProperty("post_compact"), false, "shared schema must not be mutated");
});

test("openai-responses: tools[].parameters gets post_compact", () => {
	const payload: Rec = { tools: [{ type: "function", name: "bash", parameters: baseSchema(), strict: false }] };
	assert.equal(injectPostCompactSchema(payload), 1);
	assert.ok(payload.tools[0].parameters.properties.post_compact);
	assert.deepEqual(payload.tools[0].parameters.required, ["command"]);
});

test("anthropic: tools[].input_schema gets post_compact", () => {
	const payload: Rec = { tools: [{ name: "bash", description: "d", input_schema: baseSchema() }] };
	assert.equal(injectPostCompactSchema(payload), 1);
	assert.ok(payload.tools[0].input_schema.properties.post_compact);
	assert.deepEqual(payload.tools[0].input_schema.required, ["command"]);
});

test("injection is idempotent", () => {
	const payload: Rec = {
		tools: [
			{ type: "function", function: { name: "a", parameters: baseSchema() } },
			{ name: "b", input_schema: baseSchema() },
			{ type: "function", name: "c", parameters: baseSchema() },
		],
	};
	assert.equal(injectPostCompactSchema(payload), 3);
	const snapshot = JSON.stringify(payload);
	assert.equal(injectPostCompactSchema(payload), 0);
	assert.equal(JSON.stringify(payload), snapshot);
});

test("an existing post_compact property is left alone", () => {
	const custom = { type: "string", description: "mine" };
	const payload: Rec = {
		tools: [{ name: "x", input_schema: { type: "object", properties: { post_compact: custom } } }],
	};
	assert.equal(injectPostCompactSchema(payload), 0);
	assert.equal(payload.tools[0].input_schema.properties.post_compact, custom);
});

test("strict tools are skipped", () => {
	const payload: Rec = {
		tools: [
			{ type: "function", function: { name: "a", strict: true, parameters: baseSchema() } },
			{ type: "function", name: "b", strict: true, parameters: baseSchema() },
		],
	};
	assert.equal(injectPostCompactSchema(payload), 0);
});

test("schemas without properties gain a properties object", () => {
	const payload: Rec = { tools: [{ name: "x", input_schema: { type: "object" } }] };
	assert.equal(injectPostCompactSchema(payload), 1);
	assert.deepEqual(Object.keys(payload.tools[0].input_schema.properties), ["post_compact"]);
});

test("payloads without tools, and non-object schemas, are ignored", () => {
	assert.equal(injectPostCompactSchema(undefined), 0);
	assert.equal(injectPostCompactSchema({ messages: [] }), 0);
	assert.equal(injectPostCompactSchema({ tools: [null, 1, { name: "web_search", type: "web_search_20250305" }] }), 0);
	assert.equal(withPostCompactProperty({ type: "string" }), undefined);
	assert.equal(withPostCompactProperty([]), undefined);
});
