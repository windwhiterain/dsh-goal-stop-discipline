# dsh-goal-stop-discipline

End a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) goal round when its
objective is met, instead of re-verifying the same ground every round.

A goal keeps a session working across automatic continuation rounds. Each round is one
`<goal_round>` message, and its prompt tells the model to *inspect* the current workspace and tool
results, to *not assume earlier narration is current*, and to *gather evidence that the whole
objective is achieved* before completing. Read literally, that text has no stopping rule: nothing
tells the model that evidence from an earlier round still counts, so it re-inspects the same ground,
round after round, until the goal hits its round cap.

A preset that publishes no goal tools makes that worse. In a profile whose presets own the
model-facing tools the host row is disabled, so a preset that mounts only `/goal` gives its agents a
goal command and nothing else — while the goal-round driver on the host plane keeps driving rounds,
each one instructing the model to read the goal and mark it complete. This row fixes the composition
gap instead of asking the composition to change: the goal tools exist, but stay masked until the
user has actually created a goal.

The row changes no goal state. It never completes, blocks, pauses, or edits a goal — deciding that
an objective is met is the model's call, because a plugin that marked a goal complete on its own
would assert something the evidence does not support.

It also covers the other way a round loses the user. Nothing in the continuation prompt says that a
question written into a reply is not delivered as one: the round ends, the driver queues the next
round, and the question survives only as prose. So both texts gain an **ask rule** — call
`ask_user_question` and wait for the answer — appended exactly where that tool resolves.

It also gives a long round a way to make room for itself. A goal can outgrow its context window before
it reaches its objective, and the harness's `/compact` command is human-driven while `compactNow()`
requires an idle agent — neither is reachable from a tool call, which always runs inside an open turn.
The row publishes `compact_context` and names it in the per-round notice: the model can replace a
balanced prefix of its own history with a summary and continue from there, keeping a recent tail. The
nudge appears only where the tool, a compaction backend, and the token meter all resolve.

## What it does

| Contribution | Where it lands | When |
|---|---|---|
| A discipline paragraph | The system prompt, right after the goal-tool policy | Only while the assembling agent holds an **active** goal |
| A short notice | The **first step** of a goal round, after the `<goal_round>` message | Once per round |
| A tool mask | `get_goal` / `create_goal` / `update_goal` on each agent's own scope | While that agent holds no goal, and again once its goal is `complete` |
| An ask rule | Appended to whichever of the two texts the scope gets | Only while that scope can call `ask_user_question` |
| A compaction tool | The global tool layer as `compact_context` | Whenever the row is mounted and `compactEnabled` is true |
| A compaction nudge | Appended to the per-round notice | Only while the tool, a compaction backend, and the token meter resolve for that agent |

The paragraph sets the standing rule: earlier rounds' tool results are accumulated evidence rather
than narration to re-derive, inspect only what a change could have invalidated, decide the round's
outcome before running further tools, and report what you did not confirm instead of confirming it
again.

The notice repeats it where it has the most weight — immediately after the continuation prompt the
model has just read — and says what to do next: complete the goal if the objective is already met,
otherwise take the single action that reduces the remaining work.

The ask rule says that a decision, a confirmation, or information only the user can supply is
something to put to the user as a question, not to write into the reply: the harness delivers
`ask_user_question` as a visible, answerable question and the round waits for the reply, while
anything written into the message is never delivered as a question and the goal simply starts its
next round without it. It is asked **before** completing or blocking the goal, because a closed goal
ends the run — the harness's own wrap-up then forbids further tool calls, so a question that arrives
too late is prose in a closing message.

### The tool mask

`ctx.tools.restrict({ deny })` is registered on `agent.ctx`, because a restriction filters what a
scope **inherits** (the global layer and every ancestor layer) and never what its own layer
registers. The goal tools sit in a host or preset layer above the agent, so they mask cleanly; the
disposer comes back when the goal appears.

`goal/changed` drives it. The mask is released while the goal is in a phase that `update_goal`
itself moves the goal out of — `active`, `paused`, and `blocked` — and put back when the goal is
`complete` (nothing is left to update) or `clear`ed. A mask keyed on `active` alone hid the tool at
the moment it was needed: a round that reached its objective while the goal had been paused, and a
goal that had just been blocked, both called a name the registry no longer carried, and dispatch
answered `unknown tool`. An agent whose preset publishes none of the three names gets no mask —
there is nothing to hide, and `restrict()` rejects unknown names.

The paragraph and the callable tools stay in agreement because both read the same live registry
view: while the tools are masked the model is told it has no way to close the goal, and from the
first round after `/goal create` it is told to call `update_goal`. A `paused` or `blocked` goal is the
one state where the tools outlive the paragraph, because such a goal starts no round for the
paragraph to steer while `update_goal` is still how the goal moves on.

**`get_goal` is masked and released with `update_goal`, not separately.** A goal round's prompt
carries the objective and the round number but neither the goal id nor its revision, so a model
cannot complete a goal without first reading it. `create_goal` is masked with them because the user
owns goal creation, and an existing goal rejects a second one anyway.

**`pause` and `resume` are not special-cased.** They are part of `update_goal`, and the tool's own
authority layer rejects them outside a direct human turn — so inside a goal round they stay
inert, which is correct: an autonomous round completes or blocks, it does not park the goal. The
mask now survives both phases for the same reason it survives `blocked`: the tool that would move the
goal out of them is the one a mask would take away.

### Why the ask rule is a paragraph, not a fourth variant

The goal-tool variants answer one question — can this scope close its own goal — so they are two
whole texts. The question tool is a different axis: a scope can have the goal tools, the question
tool, both, or neither, which would make four whole texts to keep in step. The ask rule is therefore
appended to whichever text the scope already earned, and only when `ctx.tools.get('ask_user_question',
scope)` resolves. A preset that mounts no question tool is told nothing about asking, which is the
same rule the goal-tool variants already follow: never name a tool the scope cannot call. Asking does
not depend on holding a goal tool, so a scope that can only ask still gets the rule — it simply still
cannot close the goal itself.

The rule rides in the same notice message and the same text block as the discipline notice, as a
second `<goal_round_ask>` block, so a round still records exactly one notice.

### The compaction tool

A tool call always runs inside an open turn, so the two obvious entries do not fit: `/compact` is a
human command, and `compactNow()` reserves the agent's idle maintenance slot and answers `busy` for an
active agent. The tool therefore uses `compactRegion()`, the seam's operation for a caller-selected
surface range, which the contract places inside the open turn that owns the transaction.

The row selects the range itself from the token meter's surface snapshot. It keeps the system head out
of the range, retains a recent tail (`compactRetainRatio`, 20% of the measured context by default), and
moves the cut back to a boundary where no tool call is waiting for its result. The backend re-checks
both edges, so a mismatch fails the call instead of splitting a tool pair.

The call forwards the turn's cancellation signal. An expected failure — no safe range, a backend that
is already compacting, a summary that is not smaller — comes back as a model-facing result rather than
an exception, so the round continues with the context it has. The tool is exclusive: the registry does
not run it beside another call whose result would change the surface while the summary is written. It
never writes a goal transition; whether the goal is done remains the model's decision.

### The compaction nudge

The nudge is a paragraph of its own appended to the per-round notice, conditional on three composition
facts: the tool is registered, a compaction backend resolves for the agent, and the token meter
resolves. A backend may live inside the preset's `isolate` realm, where `agent.ctx.get('compaction')`
does not see it, so the row asks `agentPresets.serviceFor(agent, 'compaction')` first and falls back to
the direct service read. A scope with no backend is told nothing about compacting — the same rule the
ask and goal variants follow.

It is not in the standing system-prompt paragraph because it applies to one moment — a round that has
grown long — rather than to every request while the goal is active.

### Why the paragraph is scoped to active goals

The section's text is evaluated per assembly, and the assembly's scope is the Agent. A session that
never creates a goal therefore assembles an empty section and pays no tokens for it. A goal that
already existed when the row loaded is adopted, and `goal/changed` keeps the set current, so the
paragraph disappears as soon as the goal is completed, blocked, or paused.

### Why the notice is appended, not rewritten

`goal-round-driver` fences every continuation by comparing the queued message with its own
reservation before admitting the step. Rewriting that message from another plugin fails the fence
and blocks the goal with `prompt-rejected`. Appending after `next()` returns leaves the driver's
message untouched, and the loop records the appended message as an ordinary `user/message` before it
builds the request, so the log still reconstructs exactly what the model saw.

A rejected step is passed through unchanged; a round-zero goal message is not a continuation and gets
nothing.

## Configuration

Every field lives in [cordis.patch.yml](cordis.patch.yml) or in the row's `config`.

| Field | Default | Meaning |
|---|---|---|
| `goalToolsOnDemand` | `true` | Mask the goal tools while the agent holds no goal, and once its goal is complete |
| `policyEnabled` | `true` | Render the discipline paragraph into the system prompt |
| `policyText` | see the patch | The paragraph, written as instructions to the agent |
| `policyTextWithoutGoalTools` | see the patch | The same paragraph for a scope that publishes no goal tool |
| `roundNoticeEnabled` | `true` | Append the per-round notice |
| `roundNoticeText` | see the patch | The notice the model reads at the round's first step |
| `roundNoticeTextWithoutGoalTools` | see the patch | The same notice for a scope that publishes no goal tool |
| `askEnabled` | `true` | Append the ask rule where the scope can call `ask_user_question` |
| `askPolicyText` | built in | The paragraph appended to the discipline paragraph |
| `askNoticeText` | built in | The `<goal_round_ask>` block appended to the notice |
| `compactEnabled` | `true` | Publish `compact_context` and append its nudge to the notice |
| `compactNoticeText` | built in | The `<goal_round_compact>` block appended to the notice |
| `compactRetainRatio` | `0.2` | Fraction of the measured context kept verbatim below the compacted prefix |

A wrong value fails the row's activation rather than silently disabling half of it: every flag must
be a boolean, every text a non-empty string, and `compactRetainRatio` a number in `(0, 1)`.

## What it requires from the composition

`goalToolsOnDemand` masks names that must already be published. A preset that mounts no goal tool
has nothing to mask, and the row cannot conjure one — mounting a module into a live agent scope is
the Loader's job, not a plugin's. So the preset needs:

```yaml
- id: tool-goal
  name: "@deepseek-ai/dsh-tool-goal"
```

With `goalToolsOnDemand: false` the row is inert in that respect and a preset that publishes the
tools keeps them visible from the first turn.

The ask rule has the same kind of requirement, stated the other way round: the composition publishes
the question tool, or the rule is simply left out. Mounting

```yaml
- id: tool-ask-user
  name: "@deepseek-ai/dsh-tool-ask-user"
```

is what makes the rule reach the model; a UI that answers the question is what makes the answer reach
the user (the Web and desktop bundles publish both). With `askEnabled: false` the row says nothing
about asking whatever the composition mounts.

The compaction tool needs a backend and a meter on the agent's side. The backend is whatever
implementation the session's preset mounts as `compaction` — `@deepseek-ai/dsh-compaction-basic`, a
profile-provided variant such as `dsh-compaction-threshold/engine`, or another implementation of the
seam — and the meter is `@deepseek-ai/dsh-token-meter`. A preset that mounts neither still sees the
tool schema, but the notice never names it, and a direct call reports that compaction is unavailable
instead of failing the round. The backend is resolved through the preset registry first, because a
preset's service can publish inside an `isolate` realm where a direct read does not reach it.

## What the model sees

The notice is one `user/message` per round, carrying `roundNoticeText` as its single text block.
Its source is `{ kind: 'goal-stop-discipline', form: 'notice' }`; the `notice` form keeps Chat from
rendering it as a prompt the human typed, so it appears as a collapsed notice in the transcript. A
scope that can ask carries a second `<goal_round_ask>` block in that same block, not a second
message; the same message carries a third `<goal_round_compact>` block where the compaction tool and
its services resolve.

When the model follows the ask rule, the question is a real `ask_user_question` tool call, so it
renders as an answerable question in the transcript and the round waits for the reply — the only form
of question the user is shown. A `compact_context` call is an ordinary tool call: its result is a
compact JSON value stating whether anything was replaced, how many history items were shadowed,
their estimated tokens, and one sentence about what to do next. A failed or empty compaction is
reported the same way, so it never ends the round.

While the tools are masked, `tool-goal`'s own system-prompt section still describes them. That is
the harness's paragraph for a tool the composition publishes; a model reads its tool schemas as
authoritative, so the mismatch costs a few words rather than a wrong call. Blanking that section
would need this row to shadow another plugin's registration on the agent's scope, which is a
cleverer thing than it is worth.

The row imports nothing from DSH. It runs entirely on the `ctx` its fiber receives — the `agents`,
`tools`, and `systemPrompt` services, the `agent/created`, `agent/disposed`, `agent/pre-step`, and
`goal/changed` events, and optional reads of `agentPresets`, `compaction`, and `tokenMeter` through
the service store when the compaction tool runs — which is why it resolves from any profile without a
dependency on the harness packages.

## When prompt text is not enough

A paragraph biases a model; it cannot guarantee one. If rounds still run long, the hard stop is the
goal's own round cap, which the harness records as a blocker when it is reached. Lower it for a
deployment by restating that row in a profile patch:

```yaml
- update:
    - id: goal
      config:
        defaultMaxGoalRounds: 8
```

`defaultMaxGoalRounds` only applies to a goal created without its own `max_goal_rounds`, and a goal
already created keeps the cap it was created with — `/goal edit` changes that.

## Probes

The offline probe drives `apply()` against fakes and checks when the paragraph renders, that the
mask is installed at `agent/created`, released by `goal/changed` in every phase `update_goal` can act
on, and put back by `complete`, that a preset without goal tools gets neither mask nor throw, that the
paragraph variant and the callable tools agree in both states, that unloading gives every mask back,
that the notice lands exactly once per round with the round's own request series intact, that ordinary
steps and rejected steps are untouched, that the ask rule is appended to both texts only where
`ask_user_question` resolves and dropped when `askEnabled` is false, that a scope with the question
tool but no goal tool still gets it, that `compact_context` is published with a registry-ready
definition, selects a balanced range that keeps the system head, the goal prompt, and the open step,
calls the backend's `compactRegion` with the caller's signal, reports an empty or failed compaction
without throwing, disappears with `compactEnabled: false`, and is unregistered with the row, that the
compact nudge follows the tool, the backend, and the meter, and every rejected config value:

```sh
node probe.mjs
```

## Install

The package is a bundle: it ships a patch file that inserts one row, declared through
`dsh.bundle.patch`. Add it to a profile and install it there.

```sh
dsh plugin   # or the Web plugin manager, with the spec below
```

Use the package name as the install spec:

```
windwhiterain/dsh-goal-stop-discipline
```

then restart the host if the profile manager reports `restart-required`. Working on the row itself,
install it from a checkout instead — `link:/path/to/dsh-goal-stop-discipline` — so the profile
resolves your working copy rather than the registry copy.

An installed row edits as any other local plugin only when the profile lists its file as an `hmr`
root: Node caches an imported module by URL, and a plain patch reload reuses that cached module.
Without that root, editing `index.js` re-reads the patch and reloads the *cached* module, so a change
never reaches the running host.

## Files

| File | Role |
|---|---|
| `index.js` | The row: config validation, active-goal tracking, the section, the notice, the tool mask, the ask rule, and the `compact_context` tool with its range selection |
| `cordis.patch.yml` | The whole package: one inserted row with its config |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the row's export |
| `probe.mjs` | Offline probe over all contributions |