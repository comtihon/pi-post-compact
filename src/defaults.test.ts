import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_ARG_COLLAPSE_MIN_CHARS,
	DEFAULT_TOOL_RESULT_MAX_CHARS,
	defaultDirective,
	parseDirective,
	readRuntimeConfig,
	resolveDirective,
} from "./defaults.js";

test("defaultDirective: file tools are kept verbatim", () => {
	for (const name of ["read", "write", "edit", "multiedit"]) {
		assert.equal(defaultDirective(name).exact, true, name);
	}
});

test("defaultDirective: exact reason names the file when the input has a path", () => {
	assert.equal(defaultDirective("read", { path: "src/a.ts" }).reason, "read output for src/a.ts");
	assert.equal(defaultDirective("read").reason, "read output");
});

test("defaultDirective: shell, search, mcp and unknown tools are summarized as '<tool> output'", () => {
	for (const name of ["bash", "grep", "find", "ls", "mcp", "jira_get_issue"]) {
		assert.deepEqual(defaultDirective(name, { path: "x" }), { exact: false, reason: `${name} output` });
	}
});

test("resolveDirective: an explicit directive always wins", () => {
	const explicit = { exact: false, reason: "find the export" };
	assert.deepEqual(resolveDirective({ explicit, toolName: "read" }), explicit);
	assert.deepEqual(resolveDirective({ explicit, toolName: "bash", requireDirective: true }), explicit);
});

test("resolveDirective: falls back to the default table", () => {
	assert.deepEqual(resolveDirective({ toolName: "bash" }), { exact: false, reason: "bash output" });
});

test("resolveDirective: requireDirective without an explicit one yields none", () => {
	assert.equal(resolveDirective({ toolName: "bash", requireDirective: true }), undefined);
});

test("parseDirective: accepts an object and the stringified form, rejects malformed", () => {
	assert.deepEqual(parseDirective({ exact: true, reason: "r" }), { exact: true, reason: "r" });
	assert.deepEqual(parseDirective('{"exact":false,"reason":"r"}'), { exact: false, reason: "r" });
	assert.equal(parseDirective({ exact: "yes", reason: "r" }), undefined);
	assert.equal(parseDirective({ exact: true }), undefined);
	assert.equal(parseDirective("not json"), undefined);
	assert.equal(parseDirective(null), undefined);
});

test("readRuntimeConfig: defaults with an empty env", () => {
	assert.deepEqual(readRuntimeConfig({}), {
		artifactAllResults: true,
		toolResultMaxChars: DEFAULT_TOOL_RESULT_MAX_CHARS,
		requireDirective: false,
		compactStyle: "caveman-one-sentence",
		compactMinChars: 800,
		collapseMinChars: 800,
		argCollapseMinChars: DEFAULT_ARG_COLLAPSE_MIN_CHARS,
		schemaDirective: true,
		debug: false,
	});
	assert.equal(DEFAULT_TOOL_RESULT_MAX_CHARS, 20000);
	assert.equal(DEFAULT_ARG_COLLAPSE_MIN_CHARS, 800);
});

test("readRuntimeConfig: env overrides are honoured", () => {
	const cfg = readRuntimeConfig({
		PI_ARTIFACT_ALL_RESULTS: "0",
		PI_TOOL_RESULT_MAX_CHARS: "0",
		PI_REQUIRE_DIRECTIVE: "1",
		PI_COMPACT_STYLE: "plain",
		PI_COMPACT_MIN_CHARS: "100",
		PI_COLLAPSE_MIN_CHARS: "200",
		PI_ARG_COLLAPSE_MIN_CHARS: "300",
		PI_SCHEMA_DIRECTIVE: "false",
		PI_POST_COMPACT_DEBUG: "true",
	});
	assert.deepEqual(cfg, {
		artifactAllResults: false,
		toolResultMaxChars: 0,
		requireDirective: true,
		compactStyle: "plain",
		compactMinChars: 100,
		collapseMinChars: 200,
		argCollapseMinChars: 300,
		schemaDirective: false,
		debug: true,
	});
});

test("readRuntimeConfig: invalid values fall back to defaults", () => {
	const cfg = readRuntimeConfig({
		PI_TOOL_RESULT_MAX_CHARS: "-5",
		PI_ARG_COLLAPSE_MIN_CHARS: "lots",
		PI_COMPACT_STYLE: "shakespeare",
		PI_ARTIFACT_ALL_RESULTS: "maybe",
	});
	assert.equal(cfg.toolResultMaxChars, 20000);
	assert.equal(cfg.argCollapseMinChars, 800);
	assert.equal(cfg.compactStyle, "caveman-one-sentence");
	assert.equal(cfg.artifactAllResults, true);
});
