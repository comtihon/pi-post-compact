# pi-post-compact

Context-reduction extension for the [pi coding agent](https://github.com/earendil-works/pi).

A long agent run spends most of its tokens re-sending old tool output. This extension cuts that
down in two complementary ways, and exposes the same machinery as a library so a host driving its
own provider loop can reuse it — see [Library API](#library-api).

- **Compaction** — shrink a tool result *before* the model ever sees it.
- **Collapse** — keep content the model genuinely needed verbatim, then replace it with a stub once
  it has actually been reasoned over.

Install it like any pi extension; both mechanisms are on by default.

---

## Compaction

The extension appends a block to the system prompt requiring a `post_compact` field on every tool
call except `edit` / `write` / `multiedit`:

```jsonc
post_compact: {
  exact: false,                                  // summarize the result (default)
  reason: "looking for authentication entry points"
}
```

`exact: false` results are summarized by a cheap meta-LLM at the `tool_result` hook, focused on
`reason`, and the summary is what enters history. `reason` is mandatory because a summary with no
stated target is just lossy truncation — the focus string is what makes the result shrink without
losing the part that mattered.

Guard rails, all of which fail toward keeping your data:

| Situation | Behavior |
|---|---|
| Result shorter than the threshold | kept raw — not worth an extra LLM round-trip |
| Summary is not shorter than the input | discarded, raw kept (routine on terse output like `ls`) |
| Meta-LLM unreachable, unauthorized, or erroring | kept raw, run continues |
| Result contains an image, or mixes text and non-text | skipped entirely |

`compactToolResult` never throws. A failure degrades the optimization; it does not break the agent.

## Collapse

`exact: true` results are deliberately *not* compacted — the model asked for them verbatim. Instead
they ride verbatim for exactly as long as they are useful, then get replaced.

This runs on the `context` hook, which fires before every LLM call and receives a **deep copy** of
the message list. That matters: only the outgoing payload shrinks. Session history, `/compact`,
resume, and the transcript all keep full fidelity.

What gets collapsed, and when:

| Target | Rides verbatim for | Replaced by |
|---|---|---|
| `exact: true` tool result | the round-trip it was created in | one-sentence *finding* — what you learned, not what the output contained |
| Assistant tool-call arguments | two round-trips | lexical stub (`wrote src/app.ts (5021 chars)`) — no LLM call |
| Large assistant text | two round-trips | one-sentence summary preserving decisions, findings, and paths |
| Anything still oversized | — | hard truncation at the configured ceiling |

The two-round-trip delay on tool-call arguments is not a tuning choice. Arguments created in round
*r* are executed in *r+1*, so rewriting them any earlier would change what actually runs.

The *finding* framing is where most of the compression comes from: `exact: false` answers "what does
this contain", while a collapsed verbatim result answers "what did I learn" — `sort_key found on
line 42` instead of a paragraph describing the file.

### Recovering collapsed content

Collapse trades fidelity for tokens, so the original is written to `.tool_artifacts/` first and the
stub names the path:

```
[collapsed: sort_key found on line 42 — full text: /workspace/.tool_artifacts/tc_17-result.txt]
```

Reading it back needs no special tool — the model uses its ordinary `read` or `bash`. When the write
fails, the stub omits the path rather than pointing at a file that isn't there.

### Prompt caching

Rewriting history invalidates the provider's cached prefix from the first rewritten message onward.
The collapse delay limits the blast radius, and `cacheFrontierIndex` reports where the stable prefix
ends, but the tension is real: on a provider you rely on for prompt caching, **measure before
assuming collapse is a net win**. Disable it with `--no_context_collapse`.

---

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `--meta_llm` flag | — | Model used for summaries, as `provider/model` |
| `META_LLM_PROVIDER` + `META_LLM_MODEL` | — | Same, for hosts that configure via env |
| `.pi/post-compact.json` → `meta_llm` | — | Same, per project |
| *(fallback)* | `anthropic/claude-haiku-4-5` | Used when none of the above is set |
| `--no_context_collapse` flag | off | Disable collapse; compaction stays on |
| `PI_COMPACT_MIN_CHARS` | `800` | Floor below which a tool result is not summarized |
| `PI_COLLAPSE_MIN_CHARS` | `800` | Floor below which content is not collapsed |
| `PI_TOOL_RESULT_MAX_CHARS` | `0` (off) | Hard ceiling on tool-result text |

Precedence for the meta-LLM is flag → env pair → project config → default.

## Known limitation: usage accounting

Meta-LLM tokens spent on summarizing are **invisible to pi's session stats**. The SDK's
`ExtensionAPI` / `ExtensionContext` surface exposes no way for an extension to report supplementary
usage — `getContextUsage()` is read-only, and there is no `addUsage`-style call. This is a hard SDK
limitation, not an oversight.

A host that intercepts provider HTTP itself *can* account for it: `compactOrKeep` returns `usage`
on its result for exactly that purpose. [pi-cloud-agent](https://github.com/comtihon/pi-cloud-agent)
does this, tracking meta-LLM cost separately from the agent's own token usage.

---

## Library API

Everything above is also importable, so a host running its own provider loop — one that never passes
through pi's agent loop, and so never reaches the `context` hook — can apply the same policy instead
of reimplementing it. Nothing in the core knows what a message looks like; hosts supply the targets
and perform the mutation.

```ts
import {
  compactOrKeep,             // gate + summarize + no-shrink guard, never throws
  compactToolResult,         // the raw meta-LLM summarization call
  resolveMetaLlm,            // flag → env → project config → default
  CollapseTracker,           // "is this target due for collapse yet" timing rules
  cacheFrontierIndex,        // first message still subject to rewriting
  summarizeToolCallArgs,     // lexical stub for large tool-call arguments
  truncateWithNotice,        // hard ceiling
  createArtifactStore,       // on-disk escape hatch for displaced originals
  collapseStub,              // stub text, with the artifact path when available
  buildActionSummaryInstruction,  // the "what did I learn" prompt
  ContextCollapseEngine,     // the whole collapse pass over pi's AgentMessage[]
} from "pi-post-compact";
```

Summary style is a first-class option (`style: "caveman-one-sentence"` and friends) rather than
something callers concatenate onto `reason`, which keeps *what to look for* separate from *how to
write it*.

```bash
npm run build    # tsc
npm test         # tsc, then node --test over dist (needs Node 22+)
```

## License

MIT
