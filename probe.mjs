/**
 * Offline probe for dsh-goal-stop-discipline: drives `apply()` against fakes and
 * checks which prompt text reaches the model and which tools it can call. Run
 * with `node probe.mjs`.
 *
 * The fakes mirror the five facts the row depends on: `agent/created`-shaped
 * scope keys are the Agent objects the assembly carries, `goal/changed` reports
 * the phase that decides whether the section renders and whether the goal tools
 * are masked, the tool registry answers per scope — a preset that mounts only
 * the `/goal` command resolves no `update_goal` even when the host has one — a
 * restriction registered on `agent.ctx` filters what that scope inherits, and
 * the `agent/pre-step` waterfall returns the decision the loop would log.
 */

import assert from 'node:assert/strict'
import { apply, name } from './index.js'

/** The goal tool names a preset can inherit from the host plane. */
const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']

/** A goal service standing in for `ctx.get('goals')`. */
function fakeGoalService() {
  const goals = new Map()
  return {
    goals,
    get(agent) {
      if (!goals.has(agent)) throw new Error(`agent "${agent.id}" is not live in this registry`)
      return goals.get(agent)
    },
  }
}

/**
 * An agent that is its own assembly scope, as `assembleContextFor()` builds.
 * `tools` is what the agent's scope inherits; `masks` records every restriction
 * this row registers and whether it has been given back.
 */
function fakeAgent(id = 'agent-1', tools = [...GOAL_TOOLS, 'read']) {
  const agent = { id, tools, masks: [] }
  agent.ctx = {
    tools: {
      restrict({ deny }) {
        const mask = { deny: [...deny], released: false }
        agent.masks.push(mask)
        return () => { mask.released = true }
      },
    },
  }
  return agent
}

/** Whether one agent may still call this tool, after every live mask. */
function canCall(agent, tool) {
  if (!agent.tools.includes(tool)) return false
  return !agent.masks.some(mask => !mask.released && mask.deny.includes(tool))
}

/** A context recording listeners, sections, and plugin-owned effects. */
function fakeCtx() {
  const listeners = new Map()
  const goalService = fakeGoalService()
  const sections = []
  const warnings = []
  const effects = []
  return {
    listeners,
    sections,
    warnings,
    effects,
    goalService,
    agents: { list: () => [...goalService.goals.keys()] },
    logger: { warn: message => warnings.push(message) },
    get: service => (service === 'goals' ? goalService : undefined),
    tools: {
      get: (toolName, scope) => (canCall(scope, toolName) ? { name: toolName } : undefined),
      schemas: scope => scope.tools.map(name => ({ name })),
    },
    systemPrompt: {
      getSectionOrder: key => ({ TOOL_GOAL: 400 })[key],
      section(section) {
        sections.push(section)
        return () => sections.splice(sections.indexOf(section), 1)
      },
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose()
    },
    on(event, listener) {
      assert.equal(listeners.has(event), false, `two listeners for ${event}`)
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
}

/** Mount the row and return the handles a goal round is driven through. */
function mount(config, existingAgents = []) {
  const ctx = fakeCtx()
  for (const agent of existingAgents) {
    ctx.goalService.goals.set(agent, { phase: 'active' })
  }
  apply(ctx, config)
  const section = ctx.sections[0]
  return {
    ctx,
    section,
    /** The text the section contributes for one agent's assembly. */
    render: agent => (agent === undefined ? section.text({}) : section.text({ scope: agent })),
    /** Report one goal transition. */
    change(agent, goal) {
      ctx.listeners.get('goal/changed')({ agent, change: { operation: goal.phase, ref: {}, goal } })
    },
    /** Run one pre-step through the waterfall. */
    async step(agent, messages, decision = { kind: 'enter', messages }) {
      return ctx.listeners.get('agent/pre-step')({ agent, messages }, () => Promise.resolve(decision))
    },
    /** Unload the row, running its plugin-owned disposers. */
    dispose() {
      for (const effect of ctx.effects) effect.dispose()
    },
  }
}

/** One goal continuation message as `goal-round-driver` queues it. */
function goalRound(round = 1) {
  return { id: `m-${round}`, role: 'user', content: [], source: { kind: 'goal', goalId: 'g', revision: 1, round } }
}

/** The clause that tells a model with goal tools to close its own goal. */
const CALLS_UPDATE_GOAL = 'call update_goal'

/** The clause that tells a model that can ask to call the question tool. */
const CALLS_ASK_TOOL = 'call ask_user_question'

/** Run every case and report the outcome. */
async function main() {
  const checks = []
  const check = (title, run) => checks.push({ title, run })

  check('exports the plugin name', () => {
    assert.equal(name, 'goal-stop-discipline')
  })

  check('renders the paragraph only while the assembling agent holds an active goal', () => {
    const harness = mount()
    const withGoal = fakeAgent()
    const withoutGoal = fakeAgent('agent-2')
    assert.equal(harness.render(undefined), '', 'a subject-less assembly carries no paragraph')
    assert.equal(harness.render(withoutGoal), '', 'an agent with no goal carries no paragraph')
    harness.change(withGoal, { phase: 'active' })
    assert.notEqual(harness.render(withGoal), '', 'an active goal puts the paragraph in the prompt')
    harness.change(withGoal, { phase: 'complete' })
    assert.equal(harness.render(withGoal), '', 'a completed goal takes the paragraph back out')
  })

  check('adopts a goal that already existed when the row loaded', () => {
    const existing = fakeAgent('agent-existing')
    const harness = mount(undefined, [existing])
    assert.notEqual(harness.render(existing), '')
    assert.ok(canCall(existing, 'update_goal'), 'an adopted goal is not left masked')
  })

  check('places the paragraph directly after the goal-tool policy', () => {
    const harness = mount()
    assert.equal(harness.ctx.sections.length, 1)
    assert.equal(harness.section.order, 405)
  })

  check('names update_goal only where the tool resolves', () => {
    const harness = mount()
    const withTools = fakeAgent('agent-with-tools')
    const withoutTools = fakeAgent('agent-without-tools', ['read'])
    harness.change(withTools, { phase: 'active' })
    harness.change(withoutTools, { phase: 'active' })
    assert.ok(harness.render(withTools).includes(CALLS_UPDATE_GOAL), 'a preset with the goal tool is told to use it')
    assert.ok(!harness.render(withoutTools).includes(CALLS_UPDATE_GOAL), 'a preset without it is told not to look for it')
    assert.ok(harness.render(withoutTools).includes('only the user can complete or pause it'))
  })

  check('drops the paragraph when policyEnabled is false', () => {
    const harness = mount({ policyEnabled: false })
    assert.equal(harness.ctx.sections.length, 0)
  })

  check('names ask_user_question only where the question tool resolves', () => {
    const harness = mount()
    const withAsk = fakeAgent('agent-with-ask', [...GOAL_TOOLS, 'ask_user_question'])
    const withoutAsk = fakeAgent('agent-without-ask', [...GOAL_TOOLS, 'read'])
    harness.change(withAsk, { phase: 'active' })
    harness.change(withoutAsk, { phase: 'active' })
    assert.ok(harness.render(withAsk).includes(CALLS_ASK_TOOL), 'a scope that can ask is told to call it')
    assert.ok(!harness.render(withoutAsk).includes(CALLS_ASK_TOOL), 'a scope that cannot ask is told nothing about asking')
    assert.ok(harness.render(withAsk).includes(CALLS_UPDATE_GOAL), 'the stopping rule survives the appended paragraph')
  })

  check('drops the ask rule when askEnabled is false', () => {
    const harness = mount({ askEnabled: false })
    const agent = fakeAgent('agent-no-ask-rule', [...GOAL_TOOLS, 'ask_user_question'])
    harness.change(agent, { phase: 'active' })
    assert.ok(!harness.render(agent).includes(CALLS_ASK_TOOL))
  })

  check('carries the ask rule to a scope with no goal tools but a question tool', () => {
    const harness = mount()
    const agent = fakeAgent('agent-ask-only', ['read', 'ask_user_question'])
    harness.change(agent, { phase: 'active' })
    const text = harness.render(agent)
    assert.ok(text.includes(CALLS_ASK_TOOL), 'asking does not depend on holding a goal tool')
    assert.ok(!text.includes(CALLS_UPDATE_GOAL), 'it still cannot close the goal itself')
  })

  check('masks the goal tools until the agent holds a goal', () => {
    const harness = mount()
    const agent = fakeAgent()
    harness.ctx.listeners.get('agent/created')({ agent })
    assert.equal(agent.masks.length, 1, 'a new agent cannot call a goal tool before it has a goal')
    assert.deepEqual([...agent.masks[0].deny].sort(), [...GOAL_TOOLS].sort())
    harness.change(agent, { phase: 'active' })
    assert.ok(agent.masks[0].released, 'creating the goal gives them back before the first round')
    assert.ok(canCall(agent, 'get_goal') && canCall(agent, 'update_goal'))
    harness.change(agent, { phase: 'complete' })
    assert.ok(!canCall(agent, 'update_goal'), 'closing the goal masks them again')
    assert.ok(!canCall(agent, 'create_goal'))
  })

  check('keeps the paragraph and the callable tools in agreement', () => {
    const harness = mount()
    const agent = fakeAgent()
    harness.ctx.listeners.get('agent/created')({ agent })
    harness.change(agent, { phase: 'active' })
    assert.ok(harness.render(agent).includes(CALLS_UPDATE_GOAL), 'a released agent is told to call the tool it can call')
    harness.change(agent, { phase: 'paused' })
    assert.ok(!harness.render(agent), 'a paused goal renders no paragraph at all')
  })

  check('masks nothing in a preset that mounts no goal tools', () => {
    const harness = mount()
    const agent = fakeAgent('agent-no-goal-tools', ['read', 'write'])
    harness.ctx.listeners.get('agent/created')({ agent })
    assert.equal(agent.masks.length, 0, 'there is nothing to mask, and no unknown name to reject')
  })

  check('masks nothing when goalToolsOnDemand is false', () => {
    const harness = mount({ goalToolsOnDemand: false })
    const agent = fakeAgent()
    harness.ctx.listeners.get('agent/created')({ agent })
    assert.equal(agent.masks.length, 0)
    assert.ok(canCall(agent, 'update_goal'), 'the tools stay as the composition published them')
  })

  check('gives every mask back when the row unloads', () => {
    const harness = mount()
    const agent = fakeAgent()
    harness.ctx.listeners.get('agent/created')({ agent })
    harness.dispose()
    assert.ok(agent.masks.every(mask => mask.released), 'a mask does not outlive the plugin that owns it')
    assert.ok(canCall(agent, 'update_goal'))
  })

  check('appends the notice to the first step of a goal round', async () => {
    const harness = mount()
    const agent = fakeAgent()
    harness.ctx.goalService.goals.set(agent, { phase: 'active' })
    const messages = [goalRound(3)]
    const decision = await harness.step(agent, messages, { kind: 'enter', messages, startsRequestSeries: true })
    assert.equal(decision.messages.length, 2)
    assert.deepEqual(decision.messages[0], messages[0], 'the driver\'s own message is untouched')
    assert.equal(decision.messages[1].role, 'user')
    assert.equal(decision.messages[1].source.kind, 'goal-stop-discipline')
    assert.equal(decision.messages[1].source.form, 'notice')
    assert.ok(decision.messages[1].source.summary.length <= 120, 'the notice summary is bounded')
    assert.ok(decision.messages[1].content[0].text.includes(CALLS_UPDATE_GOAL))
    assert.equal(decision.startsRequestSeries, true, 'the round keeps its own request series')
  })

  check('reports instead of calling when the scope has no goal tools', async () => {
    const harness = mount()
    const agent = fakeAgent('agent-no-goal-tools', ['read'])
    const messages = [goalRound(1)]
    const decision = await harness.step(agent, messages, { kind: 'enter', messages })
    assert.equal(decision.messages.length, 2)
    const text = decision.messages[1].content[0].text
    assert.ok(!text.includes(CALLS_UPDATE_GOAL), 'the notice does not name a tool the scope cannot call')
    assert.ok(text.includes('The user closes the goal.'))
  })

  check('appends the ask rule inside the same notice message and text block', async () => {
    const harness = mount()
    const agent = fakeAgent('agent-round-ask', [...GOAL_TOOLS, 'ask_user_question'])
    const messages = [goalRound(1)]
    const decision = await harness.step(agent, messages, { kind: 'enter', messages })
    assert.equal(decision.messages.length, 2, 'a round records exactly one notice')
    const notice = decision.messages[1]
    assert.equal(notice.content.length, 1)
    assert.equal(notice.source.form, 'notice')
    assert.ok(notice.content[0].text.includes(CALLS_UPDATE_GOAL))
    assert.ok(notice.content[0].text.includes(CALLS_ASK_TOOL))
    assert.ok(notice.content[0].text.includes('<goal_round_ask>'))
    assert.ok(notice.source.summary.length <= 120, 'the notice summary stays bounded')
  })

  check('leaves the ask rule out of a round whose scope cannot ask', async () => {
    const harness = mount()
    const agent = fakeAgent('agent-round-no-ask', [...GOAL_TOOLS])
    const messages = [goalRound(1)]
    const decision = await harness.step(agent, messages, { kind: 'enter', messages })
    const text = decision.messages[1].content[0].text
    assert.ok(!text.includes(CALLS_ASK_TOOL))
    assert.ok(!text.includes('<goal_round_ask>'))
  })

  check('drops the ask rule from the notice when askEnabled is false', async () => {
    const harness = mount({ askEnabled: false })
    const agent = fakeAgent('agent-notice-no-ask', [...GOAL_TOOLS, 'ask_user_question'])
    const messages = [goalRound(1)]
    const decision = await harness.step(agent, messages, { kind: 'enter', messages })
    assert.equal(decision.messages.length, 2)
    assert.ok(!decision.messages[1].content[0].text.includes(CALLS_ASK_TOOL))
  })

  check('leaves an ordinary step and a round-zero message alone', async () => {
    const harness = mount()
    const agent = fakeAgent()
    const user = [{ id: 'u', role: 'user', content: [], source: { kind: 'user' } }]
    const step = { messages: user }
    assert.deepEqual((await harness.step(agent, user, step)).messages, user, 'no message is added to an ordinary step')
    const zero = [goalRound(0)]
    const zeroDecision = await harness.step(agent, zero, { kind: 'enter', messages: zero })
    assert.equal(zeroDecision.messages.length, 1, 'a round-zero goal message is not a continuation')
  })

  check('passes a rejected step through untouched', async () => {
    const harness = mount()
    const messages = [goalRound(1)]
    const decision = await harness.step(fakeAgent(), messages, { kind: 'reject' })
    assert.deepEqual(decision, { kind: 'reject' })
  })

  check('drops the notice when roundNoticeEnabled is false', async () => {
    const harness = mount({ roundNoticeEnabled: false })
    const messages = [goalRound(1)]
    const decision = await harness.step(fakeAgent(), messages, { kind: 'enter', messages })
    assert.deepEqual(decision.messages, messages)
  })

  check('rejects unusable configuration at load', () => {
    assert.throws(() => mount({ policyText: '' }), /policyText/)
    assert.throws(() => mount({ policyTextWithoutGoalTools: '   ' }), /policyTextWithoutGoalTools/)
    assert.throws(() => mount({ roundNoticeText: '' }), /roundNoticeText/)
    assert.throws(() => mount({ roundNoticeTextWithoutGoalTools: '  ' }), /roundNoticeTextWithoutGoalTools/)
    assert.throws(() => mount({ askPolicyText: '' }), /askPolicyText/)
    assert.throws(() => mount({ askNoticeText: '\n ' }), /askNoticeText/)
    assert.throws(() => mount({ policyEnabled: 'yes' }), /policyEnabled/)
    assert.throws(() => mount({ goalToolsOnDemand: 'yes' }), /goalToolsOnDemand/)
    assert.throws(() => mount({ askEnabled: 'yes' }), /askEnabled/)
  })

  let failed = 0
  for (const { title, run } of checks) {
    try {
      await run()
      process.stdout.write(`ok   ${title}\n`)
    } catch (error) {
      failed += 1
      process.stdout.write(`FAIL ${title}\n${error instanceof Error ? error.stack : String(error)}\n`)
    }
  }
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
  if (failed > 0) process.exitCode = 1
}

await main()