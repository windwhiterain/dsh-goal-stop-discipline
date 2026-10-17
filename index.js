/**
 * dsh-goal-stop-discipline — make an autonomous goal round end when the
 * objective is met instead of re-verifying forever.
 *
 * The harness drives an active goal forward one `<goal_round>` message at a
 * time. Its continuation prompt tells the model to "inspect the current
 * workspace, tool results, and durable session state" and to "gather evidence
 * that the whole objective is achieved" before completing. Read on its own
 * that text has no stopping rule: nothing tells the model that evidence
 * collected in an earlier round still counts, so a model that reads it
 * literally re-inspects the same ground every round and lets the goal run to
 * its round cap. The goal-tool policy paragraph states the same idea from the
 * other side — "Mark complete only when the objective is actually achieved" —
 * which bounds the other extreme without saying when the round is done.
 *
 * This row adds that missing rule through two public seams, and changes no
 * durable goal state: it never completes, blocks, pauses, or edits a goal.
 * Deciding that an objective is met is the model's call, because a plugin that
 * marked a goal complete on its own would assert something the evidence does
 * not support.
 *
 *   * A prompt section that renders only while the assembling agent holds an
 *     active goal, so a session that never creates one pays nothing.
 *   * One notice appended to the first step of each goal round, where the round
 *     prompt itself is the freshest instruction the model has just read. It is
 *     appended after `next()` returns, so the goal-round driver's identity
 *     fence still sees the message it queued, and the loop logs the appended
 *     message as an ordinary `user/message` before the request is built.
 *
 * Both texts exist in two variants, because whether the model can close its own
 * goal is a composition choice, not a harness constant. A preset that mounts
 * only the human `/goal` command leaves no `update_goal` in scope, so naming
 * that tool would instruct a call the agent cannot make. The row asks the tool
 * registry what the assembling scope can actually call, and in the variant
 * without the goal tools the model is told that only the user can close the
 * goal and that its closing message is what decides.
 *
 * The third contribution closes that gap without changing the composition. In a
 * profile whose presets own the model-facing tools, the host row is disabled and
 * a preset that mounts no goal tool gives its agents none — while the
 * goal-round driver on the host plane keeps driving that agent's rounds, and its
 * own continuation prompt tells the model to read the goal and mark it
 * complete. The row masks the goal tools on each agent's own scope while that
 * agent holds no goal and while it holds a completed one, and leaves them in
 * place for every phase in between: a paused or blocked goal is moved out of
 * that phase by `update_goal` itself, so hiding the tool there made the model
 * call a name the registry no longer carried and dispatch answered `unknown
 * tool`. A session that never creates a goal therefore pays nothing for three
 * schemas, and one whose goal is finished gets the cost back.
 *
 * A fourth contribution covers the other way an autonomous round loses the
 * user. Nothing in the continuation prompt tells the model that a question
 * written into its reply is not delivered as one: the round ends, the driver
 * queues the next round, and the question is only prose the user has to notice
 * and answer by hand. Both texts therefore gain an ask rule, appended as its
 * own paragraph rather than as another full variant, so it stays conditional on
 * the same fact the goal-tool variants are conditional on — whether this scope
 * can actually call `ask_user_question`. A composition that publishes no
 * question tool is told nothing about asking, and one that does is told to ask
 * before it closes the goal, while the goal is still live.
 *
 * A fifth contribution gives a long round a way to make room for itself. An
 * autonomous goal can outgrow its context window before it reaches its
 * objective, and the harness's `/compact` command is human-driven while
 * `compactNow()` reserves an idle agent — neither is reachable from a tool call
 * inside an open turn. The row publishes `compact_context` and names it in the
 * per-round notice, where the model has just been reminded what the round is
 * for. The tool selects a balanced prefix that keeps a recent tail and calls the
 * backend's explicit-region operation, which runs inside the open turn and
 * needs no pressure threshold; it reports the backend's own result and never
 * writes a goal transition. The nudge is appended only where the tool, a
 * compaction backend, and the token meter all resolve for that agent, and a
 * gauge rendered from the live measurement and the routed model's declared
 * window rides beside it so "running low" is a number, not a guess.
 *
 * @module dsh-goal-stop-discipline
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name. */
export const name = 'goal-stop-discipline'

/**
 * Services this row needs before it activates. `goals` is deliberately absent:
 * a profile without the goal service has no goal to discipline, and reading
 * it through the service store keeps this row loadable there.
 */
export const inject = ['agents', 'systemPrompt', 'tools']

/** Section name of the discipline paragraph; unique within the global prompt layer. */
const SECTION_NAME = 'goal-stop-discipline:policy'

/** Producer kind stamped on the per-round notice, as recorded in the session log. */
const SOURCE_KIND = 'goal-stop-discipline'

/** One-line account of the notice, shown without expanding its row. */
const NOTICE_SUMMARY = 'Goal round: end the run once the objective is met, ask the user when the round needs them'

/** Placement of the discipline paragraph: directly after the goal-tool policy. */
const POLICY_ORDER_OFFSET = 5

/**
 * The model-facing goal tools this row masks while an agent holds no goal and
 * while it holds a completed one. `get_goal` belongs beside `update_goal`
 * because the continuation prompt carries the objective and the round number but
 * neither the goal id nor its revision, so a model cannot complete a goal
 * without first reading it. `create_goal` stays masked with them: the user owns
 * goal creation, and a goal that already exists rejects a second one anyway.
 */
const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']

/**
 * The phases in which an agent keeps its goal tools.
 *
 * Every one of them is a phase `update_goal` itself moves the goal out of, which
 * is what a mask keyed on `active` alone got wrong: a round that reached its
 * objective, or a goal the office or the user had paused, saw the tool disappear
 * from its own scope and dispatch answered `unknown tool` for the call the round
 * prompt had just asked for. `complete` is absent because nothing is left to
 * update once the goal is closed, so the mask returns and the request stops
 * paying for the schemas.
 */
const KEEPS_GOAL_TOOLS = new Set(['active', 'paused', 'blocked'])

/**
 * The question tool the ask rule names. Whether a scope can call it is a
 * composition fact, so the rule is appended only where it resolves: a preset
 * that mounts no question tool is told nothing about asking rather than told
 * to call a tool its scope cannot reach.
 */
const ASK_TOOL = 'ask_user_question'

/**
 * The model-facing tool that compacts an open turn's history. Its name is fixed
 * because the per-round notice names it; a configurable name would let the two
 * drift apart.
 */
const COMPACT_TOOL = 'compact_context'

/** Model-facing account of when a forced reduction is worth its cost. */
const COMPACT_DESCRIPTION =
  'Replace older conversation history with a summary so this session can continue a long round when '
  + 'its context is nearly full. Use it before the context runs out and while you still have work to do; '
  + 'the most recent messages are kept and the round continues from the summary.'

/** Canonical result of one `compact_context` call. */
const COMPACT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    compacted: { type: 'boolean' },
    shadowedItems: { type: 'integer' },
    shadowedTokens: { type: 'integer' },
    message: { type: 'string' },
  },
  required: ['compacted', 'shadowedItems', 'shadowedTokens', 'message'],
}

/** Shared opening: what a round inherits from the rounds before it. */
const EVIDENCE_RULE =
  'Goal round discipline. A goal round continues work that earlier rounds in this '
  + 'session already started, so this session\'s history — including earlier rounds\' '
  + 'tool results — is accumulated evidence, not narration to be re-derived. Inspect '
  + 'only what a change since that evidence could have invalidated, and never repeat '
  + 'an inspection whose result the session already records.\n\n'

/** The paragraph for an agent that can call `update_goal` itself. */
const DEFAULT_POLICY_TEXT =
  EVIDENCE_RULE
  + 'Decide the outcome of this round before running further tools. When the '
  + 'objective is achieved, call update_goal with action complete and let the run '
  + 'end; a completed goal requests no further rounds. When it is not achieved, take '
  + 'the single action that most reduces the remaining work and leave the goal active '
  + 'for the next round. Uncertainty about side conditions, and work beyond the '
  + 'objective, belong in the closing message rather than in another round of '
  + 'checking: say what you did not confirm instead of confirming it again.'

/**
 * The paragraph for an agent with no goal tools. The goal is still armed and
 * still driving rounds, and the model has no way to stop that, so the only
 * useful instruction is to report the outcome and let the user close it.
 */
const DEFAULT_POLICY_TEXT_WITHOUT_GOAL_TOOLS =
  EVIDENCE_RULE
  + 'Decide the outcome of this round before running further tools. You have no tool '
  + 'that closes this goal: only the user can complete or pause it. State the outcome '
  + 'plainly in your closing message — whether the objective is now achieved, or the one '
  + 'action that still remains — and then stop. Do not spend another round confirming '
  + 'what you have already established, and do not wait for a tool that will not come.'

/** The notice for an agent that can call `update_goal` itself. */
const DEFAULT_ROUND_NOTICE_TEXT =
  '<goal_round_discipline>\n'
  + 'This round continues the same goal as the earlier rounds of this session. Their '
  + 'tool results are your evidence and remain valid: re-run an inspection only if '
  + 'something has changed since it. If the objective is already achieved, call '
  + 'update_goal with action complete and end the run now. Otherwise take the single '
  + 'next action that reduces the remaining work and leave the goal active.\n'
  + '</goal_round_discipline>'

/** The notice for an agent with no goal tools. */
const DEFAULT_ROUND_NOTICE_TEXT_WITHOUT_GOAL_TOOLS =
  '<goal_round_discipline>\n'
  + 'This round continues the same goal as the earlier rounds of this session. Their '
  + 'tool results are your evidence and remain valid: re-run an inspection only if '
  + 'something has changed since it. You have no tool that closes this goal, so do not '
  + 'look for one: say in your closing message whether the objective is now achieved or '
  + 'what single action remains, then stop. The user closes the goal.\n'
  + '</goal_round_discipline>'

/**
 * The paragraph appended to the standing rule for a scope that can ask. It is a
 * paragraph of its own rather than a fourth full variant, because the question
 * tool is orthogonal to the goal tools: a scope may have one, both, or neither.
 */
const DEFAULT_ASK_POLICY_TEXT =
  'If this round needs the user — a decision, a confirmation, or information you cannot obtain yourself '
  + '— call ask_user_question and wait for the answer. A question written into your message is not '
  + 'delivered to the user, and the next round starts without it. Ask before you complete or block the '
  + "goal: once the goal is closed this run ends, and what you asked survives only as prose in your "
  + 'closing message.'

/** The block appended to the per-round notice for a scope that can ask. */
const DEFAULT_ASK_NOTICE_TEXT =
  '<goal_round_ask>\n'
  + 'If this round needs the user — a decision, a confirmation, or information you cannot obtain '
  + 'yourself — call ask_user_question and wait for the answer, before you complete or block the goal. '
  + 'A question written into your message is not delivered to the user: this goal simply starts its next '
  + 'round without it.\n'
  + '</goal_round_ask>'

/** The block appended to the per-round notice for a scope that can compact. */
const DEFAULT_COMPACT_NOTICE_TEXT =
  '<goal_round_compact>\n'
  + 'If this round is running low on context — the conversation has grown long and substantial work '
  + 'remains — call compact_context before your next request. It replaces older history with a summary '
  + 'so the round can continue; do this before the context runs out, not after a request fails.\n'
  + '</goal_round_compact>'

/**
 * The block appended before the compact nudge with the live context numbers.
 *
 * `{used}`, `{window}`, `{remaining}`, and `{percent}` are replaced at the
 * round's first step. Every placeholder is required, so a deployment cannot
 * silently drop the number the model is supposed to read.
 */
const DEFAULT_COMPACT_GAUGE_TEXT =
  '<goal_round_context>\n'
  + 'Context use: about {used} of {window} tokens; about {remaining} remain ({percent}% used).\n'
  + '</goal_round_context>'

/** Deployment defaults for {@link resolveConfig}. */
const DEFAULT_CONFIG = {
  goalToolsOnDemand: true,
  policyEnabled: true,
  policyText: DEFAULT_POLICY_TEXT,
  policyTextWithoutGoalTools: DEFAULT_POLICY_TEXT_WITHOUT_GOAL_TOOLS,
  roundNoticeEnabled: true,
  roundNoticeText: DEFAULT_ROUND_NOTICE_TEXT,
  roundNoticeTextWithoutGoalTools: DEFAULT_ROUND_NOTICE_TEXT_WITHOUT_GOAL_TOOLS,
  askEnabled: true,
  askPolicyText: DEFAULT_ASK_POLICY_TEXT,
  askNoticeText: DEFAULT_ASK_NOTICE_TEXT,
  compactEnabled: true,
  compactNoticeText: DEFAULT_COMPACT_NOTICE_TEXT,
  compactGaugeEnabled: true,
  compactGaugeText: DEFAULT_COMPACT_GAUGE_TEXT,
  compactRetainRatio: 0.2,
}

/**
 * Validate and complete the row configuration.
 *
 * Every supplied value is checked here: a wrong one must fail the activation
 * instead of silently disabling a half of the discipline or steering the model
 * with an empty paragraph.
 * @param raw - the row's `config` object, or undefined.
 * @returns the complete configuration.
 * @throws {TypeError} when a supplied field has the wrong type or an unusable value.
 */
function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  for (const field of ['goalToolsOnDemand', 'policyEnabled', 'roundNoticeEnabled', 'askEnabled', 'compactEnabled', 'compactGaugeEnabled']) {
    if (typeof config[field] !== 'boolean') {
      throw new TypeError(`dsh-goal-stop-discipline: config.${field} must be a boolean, got ${JSON.stringify(config[field])}`)
    }
  }
  if (typeof config.compactRetainRatio !== 'number' || !Number.isFinite(config.compactRetainRatio)
    || config.compactRetainRatio <= 0 || config.compactRetainRatio >= 1) {
    throw new TypeError(
      `dsh-goal-stop-discipline: config.compactRetainRatio must be a number in (0, 1), `
      + `got ${JSON.stringify(config.compactRetainRatio)}`,
    )
  }
  for (const field of [
    'policyText', 'policyTextWithoutGoalTools', 'roundNoticeText', 'roundNoticeTextWithoutGoalTools',
    'askPolicyText', 'askNoticeText', 'compactNoticeText', 'compactGaugeText',
  ]) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new TypeError(`dsh-goal-stop-discipline: config.${field} must be a non-empty string, got ${JSON.stringify(config[field])}`)
    }
  }
  for (const placeholder of ['{used}', '{window}', '{remaining}', '{percent}']) {
    if (!config.compactGaugeText.includes(placeholder)) {
      throw new TypeError(`dsh-goal-stop-discipline: config.compactGaugeText must contain ${placeholder}`)
    }
  }
  return config
}

/**
 * Whether one message is the continuation prompt of an admitted goal round.
 *
 * Only a positive round qualifies: the goal domain also labels a round-zero
 * message, which is not a continuation and must not attract the notice.
 * @param message - one message a pre-step decision proposes.
 * @returns whether the message continues an active goal.
 */
function isGoalRound(message) {
  const source = message?.source
  return source?.kind === 'goal' && Number.isSafeInteger(source.round) && source.round > 0
}

/**
 * Build the notice the loop records before the round's first request.
 *
 * The object is plain JSON on purpose: it is appended to the pre-step decision
 * and the loop appends it as a `user/message`, so the log records it and the
 * transcript can rebuild it. The `notice` form is what keeps Chat from
 * rendering the injection as a prompt the user typed.
 * @param text - the notice text for the text variant this agent needs.
 * @returns a user-role message carrying one text block.
 */
function noticeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'notice', summary: NOTICE_SUMMARY },
  }
}

/**
 * Build one canonical `compact_context` result.
 * @param compacted - whether the engine replaced a range.
 * @param shadowedItems - number of surface nodes the engine replaced.
 * @param shadowedTokens - the engine's heuristic price of the replaced range.
 * @param message - model-facing account of what happened and what to do next.
 * @returns the value declared by {@link COMPACT_OUTPUT_SCHEMA}.
 */
function compactValue(compacted, shadowedItems, shadowedTokens, message) {
  return { compacted, shadowedItems, shadowedTokens, message }
}

/**
 * The compaction backend this agent's composition supplies.
 *
 * A preset's backend can publish inside an `isolate` realm, where a direct
 * `agent.ctx.get('compaction')` does not resolve; the preset registry knows the
 * revision that agent joined. The direct read remains the fallback for a
 * deployment without a preset roster.
 * @param ctx - plugin context.
 * @param agent - agent whose composition is asked.
 * @returns the backend, or undefined when this session has none.
 */
function compactionOf(ctx, agent) {
  const scoped = ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction')
  if (scoped !== undefined) return scoped
  return agent.ctx?.get?.('compaction') ?? ctx.get('compaction')
}

/**
 * The token meter this agent's composition supplies.
 * @param ctx - plugin context.
 * @param agent - agent whose composition is asked.
 * @returns the meter, or undefined when this session has none.
 */
function tokenMeterOf(ctx, agent) {
  return agent.ctx?.get?.('tokenMeter') ?? ctx.get('tokenMeter')
}

/**
 * The provider/model route the latest request used, or the agent's own default.
 *
 * The gauge prices the window of the model that will serve this round. The
 * session's latest request header is the durable answer; an agent whose first
 * request has not been recorded yet falls back to its configured route.
 * @param agent - agent whose latest request header is read.
 * @returns the routed target, or undefined when the composition names none.
 */
function routedTargetOf(agent) {
  const config = agent.session?.requestHeader?.()?.config
  if (typeof config?.provider === 'string' && config.provider.length > 0
    && typeof config.model === 'string' && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const options = agent.options
  if (typeof options?.provider === 'string' && options.provider.length > 0
    && typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/**
 * Render the per-round context gauge from live pressure and the routed model's
 * declared window.
 *
 * The measurement is the request pressure the automatic compaction policy reads,
 * taken after `next()` returns so a pressure reduction that ran in this pre-step
 * is already reflected. A route without a declared window leaves the gauge out;
 * the nudge still arrives.
 * @param ctx - plugin context.
 * @param agent - agent whose surface is measured.
 * @param signal - the pre-step's cancellation signal.
 * @param template - the configured placeholder text.
 * @returns the rendered block, or an empty string when a fact is missing.
 */
async function contextGauge(ctx, agent, signal, template) {
  const meter = tokenMeterOf(ctx, agent)
  const llm = agent.ctx?.get?.('llm') ?? ctx.get('llm')
  const target = routedTargetOf(agent)
  if (meter === undefined || llm === undefined || target === undefined) return ''
  let info
  try {
    info = await llm.resolveModelInfo(target.provider, target.model, signal)
  } catch {
    // A route with no catalog entry declares no window, so there is no gauge.
    return ''
  }
  const window = info?.context?.contextWindow
  if (!Number.isSafeInteger(window) || window <= 0) return ''
  let measured
  try {
    measured = meter.measure(agent.session).totalTokens
  } catch {
    // A meter that cannot replay this surface leaves the gauge out.
    return ''
  }
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0) return ''
  const used = Math.round(measured)
  const remaining = Math.max(0, window - used)
  const percent = Math.min(100, Math.round((used / window) * 100))
  return template
    .replaceAll('{used}', String(used))
    .replaceAll('{window}', String(window))
    .replaceAll('{remaining}', String(remaining))
    .replaceAll('{percent}', String(percent))
}

/**
 * The change in unanswered tool calls one surface event contributes.
 *
 * The cut rule mirrors `@deepseek-ai/dsh-compaction`'s tool-pairing balance: a
 * cut is safe when every tool call before it has its result. This row cannot
 * import that helper without depending on the harness, so it folds the same
 * per-event delta here.
 * @param event - one session event in surface order.
 * @returns the delta, or zero for events that carry no tool call or result.
 */
function toolCallDelta(event) {
  switch (event?.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/**
 * Select a balanced prefix of the current surface, retaining a recent tail.
 *
 * The system head at surface node 0 is never shadowed. Both edges are cuts with
 * no unanswered tool call, so the replacement cannot split a call from its
 * result.
 * @param session - session whose surface is read.
 * @param measurement - the token meter's snapshot for that surface.
 * @param retainTokens - minimum recent tail to keep verbatim.
 * @returns the inclusive surface span to replace, or null when no cut fits.
 */
function selectCompactRange(session, measurement, retainTokens) {
  const nodes = session?.surface?.nodes
  const priced = measurement?.nodes
  if (!Array.isArray(nodes) || !Array.isArray(priced)
    || nodes.length === 0 || nodes.length !== priced.length) return null
  // One entry per cut: entry `i` is the cut before surface node `i`, and the
  // final entry is the cut after the tail.
  const cuts = [true]
  let open = 0
  for (let index = 0; index < nodes.length; index += 1) {
    if (priced[index]?.seq !== nodes[index]) return null
    const event = session.eventAt(nodes[index])
    if (event === undefined) return null
    open += toolCallDelta(event)
    if (open < 0) return null
    cuts.push(open === 0)
  }
  const firstIdx = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  let keep = nodes.length
  let accumulated = 0
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index]?.tokens ?? 0
    keep = index
    if (accumulated >= retainTokens) break
  }
  if (keep <= firstIdx) return null
  while (keep > firstIdx && cuts[keep] !== true) keep -= 1
  if (keep <= firstIdx) return null
  return { start: nodes[firstIdx], end: nodes[keep - 1] }
}

/**
 * Build the `compact_context` tool for one row instance.
 *
 * A tool call runs inside the open turn it belongs to, so `compactNow()` is not
 * an option: it reserves the agent's idle maintenance slot. The explicit-region
 * operation is the public reduction path for a caller-selected span, so the tool
 * selects a prefix that keeps a recent tail and lets the backend replace it.
 * @param ctx - plugin context; the row owns the registration.
 * @param retainRatio - fraction of the measured context kept verbatim.
 * @returns a registry-ready tool definition.
 */
function compactTool(ctx, retainRatio) {
  return {
    name: COMPACT_TOOL,
    description: COMPACT_DESCRIPTION,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: COMPACT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    /**
     * Run one forced reduction for the calling agent.
     * @param _args - no arguments; the tool always compacts this session.
     * @param exec - the call's agent, cancellation signal, and dispatch identity.
     * @returns whether anything was replaced and what the model should do next.
     */
    async execute(_args, exec) {
      const agent = exec.agent
      const compaction = agent === undefined ? undefined : compactionOf(ctx, agent)
      const meter = agent === undefined ? undefined : tokenMeterOf(ctx, agent)
      if (agent === undefined || compaction === undefined || meter === undefined) {
        return compactValue(false, 0, 0, 'Compaction is not available in this session. Continue with the current context.')
      }
      try {
        const measurement = meter.measure(agent.session)
        const retainTokens = Math.max(1, Math.floor(measurement.totalTokens * retainRatio))
        const range = selectCompactRange(agent.session, measurement, retainTokens)
        if (range === null) {
          return compactValue(false, 0, 0, 'No older history could be compacted right now. Continue with the current context.')
        }
        const result = await compaction.compactRegion(range.start, range.end, agent, exec.signal)
        const shadowedItems = result.shadowedSeqs.length
        const shadowedTokens = result.shadowedTokenCount
        return compactValue(
          true,
          shadowedItems,
          shadowedTokens,
          `Compacted ${shadowedItems} older history items (~${shadowedTokens} tokens) into a summary. `
          + 'Continue this round from that summary; the most recent messages are unchanged.',
        )
      } catch (error) {
        if (exec.signal.aborted) throw error
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-goal-stop-discipline: ${COMPACT_TOOL} failed: ${detail}`)
        return compactValue(false, 0, 0, `Compaction could not run: ${detail}. Continue with the current context.`)
      }
    },
  }
}

/**
 * Install the discipline's contributions: the standing paragraph, the per-round
 * notice, the on-demand goal-tool mask, the conditional ask rule that rides in
 * both texts, and the conditional `compact_context` tool with its gauge and
 * nudge.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param raw - the row's `config` object, or undefined.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)

  /**
   * The last phase seen for each agent; the WeakMap keeps disposed agents collectable.
   *
   * An agent with no entry holds no goal, which is the same state as a cleared
   * one, so the mask needs no third state.
   */
  const phases = new WeakMap()

  /** Live goal-tool masks, keyed by agent so a goal's end can give them back. */
  const gates = new Map()

  /**
   * Hide the goal tools one agent can see, unless it already holds a mask.
   *
   * The mask is registered on `agent.ctx` because a restriction filters what a
   * scope INHERITS; the tools themselves sit in a host or preset layer above it.
   * A scope that resolves none of them has nothing to mask — that preset simply
   * mounts no goal tools, which is a composition fact this row does not change.
   * @param agent - the agent to mask.
   */
  function maskGoalTools(agent) {
    if (!config.goalToolsOnDemand || gates.has(agent) || KEEPS_GOAL_TOOLS.has(phases.get(agent))) return
    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    const names = GOAL_TOOLS.filter(tool => visible.includes(tool))
    if (names.length === 0) return
    gates.set(agent, agent.ctx.tools.restrict({ deny: names }))
  }

  /**
   * Give one agent's goal tools back, while its goal is in a phase `update_goal`
   * moves it out of, and again when the row unloads.
   * @param agent - the agent to unmask.
   */
  function unmaskGoalTools(agent) {
    gates.get(agent)?.()
    gates.delete(agent)
  }

  /**
   * The phase of the goal one live agent holds.
   * @param agent - the live agent owning the goal.
   * @returns the phase the goal service reports, or undefined when it holds none.
   */
  function goalPhase(agent) {
    try {
      return ctx.get('goals')?.get(agent)?.phase
    } catch (error) {
      // The goal service rejects an agent it no longer lists as live; a goal
      // registry failure leaves this row silent rather than breaking a turn.
      ctx.logger.warn(`dsh-goal-stop-discipline: could not read the goal of "${agent.id}": ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Whether one scope can call `update_goal`. A preset is a child scope of the
   * host composition, so a preset that mounts only the `/goal` command resolves
   * no goal tool even though the host has one.
   * @param agent - the scope asking, omitted when the assembly has no subject.
   * @returns whether the goal tool is visible to that scope.
   */
  function canCloseGoal(agent) {
    return agent !== undefined && ctx.tools.get('update_goal', agent) !== undefined
  }

  /**
   * Whether one scope can put a question to the user. Read from the same live
   * registry view as the goal tools, so the ask rule is appended exactly where
   * the model can act on it and left out where naming it would be a dead end.
   * @param agent - the scope asking, omitted when the assembly has no subject.
   * @returns whether the question tool is visible to that scope.
   */
  function canAskUser(agent) {
    return agent !== undefined && ctx.tools.get(ASK_TOOL, agent) !== undefined
  }

  /**
   * Whether one scope can compact its own history. All three are composition
   * facts: the tool must be registered for this row, and the agent's own realm
   * must supply both a compaction backend and a token meter. Naming the tool
   * where any is missing would instruct a call that cannot succeed.
   * @param agent - the scope asking.
   * @returns whether the tool and the services it needs resolve for that agent.
   */
  function canCompact(agent) {
    return ctx.tools.get(COMPACT_TOOL, agent) !== undefined
      && compactionOf(ctx, agent) !== undefined
      && tokenMeterOf(ctx, agent) !== undefined
  }

  // A goal that already existed when this row loaded is adopted here, phase and
  // all; goals created later arrive through `goal/changed`. The phase is read
  // once per live agent, so a goal that keeps its tools never starts masked.
  for (const agent of ctx.agents.list()) {
    phases.set(agent, goalPhase(agent))
    maskGoalTools(agent)
  }

  ctx.on('agent/created', ({ agent }) => { maskGoalTools(agent) })
  ctx.on('agent/disposed', ({ agent }) => { unmaskGoalTools(agent); gates.delete(agent) })

  ctx.on('goal/changed', ({ agent, change }) => {
    // A `clear` carries no goal, which leaves the phase undefined and the mask
    // in place — the same state as an agent that never had one.
    const phase = change.goal?.phase
    phases.set(agent, phase)
    if (KEEPS_GOAL_TOOLS.has(phase)) unmaskGoalTools(agent)
    else maskGoalTools(agent)
  })

  if (config.compactEnabled) {
    // Registered on this row's own scope, so the tool outlives no HMR reload.
    ctx.effect(
      () => ctx.tools.register(compactTool(ctx, config.compactRetainRatio)),
      'goal-stop-discipline compact tool',
    )
  }

  if (config.policyEnabled) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + POLICY_ORDER_OFFSET,
      // The assembly scope is the agent, so a session that never created a goal
      // assembles an empty section instead of carrying the paragraph. Only an
      // active goal renders it: a paused or blocked one starts no round for the
      // paragraph to steer.
      text: context => {
        const scope = context.scope
        if (scope === undefined || phases.get(scope) !== 'active') return ''
        const paragraph = canCloseGoal(scope)
          ? config.policyText
          : config.policyTextWithoutGoalTools
        return config.askEnabled && canAskUser(scope)
          ? `${paragraph}\n${config.askPolicyText}`
          : paragraph
      },
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (!config.roundNoticeEnabled || decision.kind !== 'enter') return decision
    // The goal-round message is claimed by the round's first step only, so this
    // runs once per round rather than once per step of that round.
    if (!decision.messages.some(isGoalRound)) return decision
    const text = canCloseGoal(agent)
      ? config.roundNoticeText
      : config.roundNoticeTextWithoutGoalTools
    // The ask, gauge, and compact rules ride in the same notice message and the
    // same text block, so a round still records exactly one notice.
    const parts = [text]
    if (config.askEnabled && canAskUser(agent)) parts.push(config.askNoticeText)
    if (config.compactEnabled && canCompact(agent)) {
      if (config.compactGaugeEnabled) {
        const gauge = await contextGauge(ctx, agent, signal, config.compactGaugeText)
        if (gauge !== '') parts.push(gauge)
      }
      parts.push(config.compactNoticeText)
    }
    return { ...decision, messages: [...decision.messages, noticeMessage(parts.join('\n'))] }
  })

  // The masks live on the agents' own scopes, not on this plugin's, so the
  // plugin's own disposal is what has to give them back.
  ctx.effect(() => () => {
    for (const agent of gates.keys()) unmaskGoalTools(agent)
    gates.clear()
  }, 'goal-stop-discipline tool masks')
}