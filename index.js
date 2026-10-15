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
 * complete. The row masks the goal tools on each agent's own scope until that
 * agent holds an active goal, and releases the mask as soon as one exists, so
 * the tools appear for the round that needs them and cost nothing before it.
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
 * The model-facing goal tools this row masks until an agent holds an active
 * goal. `get_goal` belongs beside `update_goal` because the continuation prompt
 * carries the objective and the round number but neither the goal id nor its
 * revision, so a model cannot complete a goal without first reading it.
 * `create_goal` stays masked with them: the user owns goal creation, and a goal
 * that already exists rejects a second one anyway.
 */
const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']

/**
 * The question tool the ask rule names. Whether a scope can call it is a
 * composition fact, so the rule is appended only where it resolves: a preset
 * that mounts no question tool is told nothing about asking rather than told
 * to call a tool its scope cannot reach.
 */
const ASK_TOOL = 'ask_user_question'

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
  for (const field of ['goalToolsOnDemand', 'policyEnabled', 'roundNoticeEnabled', 'askEnabled']) {
    if (typeof config[field] !== 'boolean') {
      throw new TypeError(`dsh-goal-stop-discipline: config.${field} must be a boolean, got ${JSON.stringify(config[field])}`)
    }
  }
  for (const field of [
    'policyText', 'policyTextWithoutGoalTools', 'roundNoticeText', 'roundNoticeTextWithoutGoalTools',
    'askPolicyText', 'askNoticeText',
  ]) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new TypeError(`dsh-goal-stop-discipline: config.${field} must be a non-empty string, got ${JSON.stringify(config[field])}`)
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
 * Install the discipline's contributions: the standing paragraph, the per-round
 * notice, the on-demand goal-tool mask, and the conditional ask rule that rides
 * in both texts.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param raw - the row's `config` object, or undefined.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)

  /** Agents whose current goal is active; the WeakSet keeps disposed agents collectable. */
  const active = new WeakSet()

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
    if (!config.goalToolsOnDemand || gates.has(agent) || active.has(agent)) return
    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    const names = GOAL_TOOLS.filter(tool => visible.includes(tool))
    if (names.length === 0) return
    gates.set(agent, agent.ctx.tools.restrict({ deny: names }))
  }

  /**
   * Give one agent's goal tools back, once its goal exists or the row unloads.
   * @param agent - the agent to unmask.
   */
  function unmaskGoalTools(agent) {
    gates.get(agent)?.()
    gates.delete(agent)
  }

  /**
   * Whether this agent currently holds an active goal.
   * @param agent - the live agent owning the goal.
   * @returns whether the goal service reports an active goal.
   */
  function hasActiveGoal(agent) {
    try {
      return ctx.get('goals')?.get(agent)?.phase === 'active'
    } catch (error) {
      // The goal service rejects an agent it no longer lists as live; a goal
      // registry failure leaves this row silent rather than breaking a turn.
      ctx.logger.warn(`dsh-goal-stop-discipline: could not read the goal of "${agent.id}": ${error instanceof Error ? error.message : String(error)}`)
      return false
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

  // A goal that already existed when this row loaded is adopted here; goals
  // created later arrive through `goal/changed`. Every live agent is masked
  // first, so a goal adopted above never leaves its tools masked.
  for (const agent of ctx.agents.list()) {
    maskGoalTools(agent)
    if (hasActiveGoal(agent)) {
      active.add(agent)
      unmaskGoalTools(agent)
    }
  }

  ctx.on('agent/created', ({ agent }) => { maskGoalTools(agent) })
  ctx.on('agent/disposed', ({ agent }) => { unmaskGoalTools(agent); gates.delete(agent) })

  ctx.on('goal/changed', ({ agent, change }) => {
    if (change.goal?.phase === 'active') {
      active.add(agent)
      unmaskGoalTools(agent)
    } else {
      active.delete(agent)
      maskGoalTools(agent)
    }
  })

  if (config.policyEnabled) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + POLICY_ORDER_OFFSET,
      // The assembly scope is the agent, so a session that never created a goal
      // assembles an empty section instead of carrying the paragraph.
      text: context => {
        const scope = context.scope
        if (scope === undefined || !active.has(scope)) return ''
        const paragraph = canCloseGoal(scope)
          ? config.policyText
          : config.policyTextWithoutGoalTools
        return config.askEnabled && canAskUser(scope)
          ? `${paragraph}\n${config.askPolicyText}`
          : paragraph
      },
    })
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!config.roundNoticeEnabled || decision.kind !== 'enter') return decision
    // The goal-round message is claimed by the round's first step only, so this
    // runs once per round rather than once per step of that round.
    if (!decision.messages.some(isGoalRound)) return decision
    const text = canCloseGoal(agent)
      ? config.roundNoticeText
      : config.roundNoticeTextWithoutGoalTools
    // The ask rule rides in the same notice message and the same text block, so
    // a round still records exactly one notice.
    const asked = config.askEnabled && canAskUser(agent) ? `${text}\n${config.askNoticeText}` : text
    return { ...decision, messages: [...decision.messages, noticeMessage(asked)] }
  })

  // The masks live on the agents' own scopes, not on this plugin's, so the
  // plugin's own disposal is what has to give them back.
  ctx.effect(() => () => {
    for (const agent of gates.keys()) unmaskGoalTools(agent)
    gates.clear()
  }, 'goal-stop-discipline tool masks')
}