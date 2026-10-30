/**
 * M1 host-half acceptance: fingerprint, tee, record fidelity, and correlation.
 *
 * The fixtures mirror both upstream review shapes (official and the multi-root
 * fork) and every negative the fingerprint must refuse. The tee tests inject
 * failures on BOTH sides of its boundary: a recording-path failure must be
 * contained, while an upstream stream failure must keep propagating.
 */

import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { teeReviewStream, type ReviewCaptureSink } from '../src/capture.ts'
import { matchReviewRequest } from '../src/compat/review-fingerprint.ts'
import type { ReviewCaptureHost } from '../src/host.ts'
import {
  abortedFinish,
  ALLOW_TEXT,
  approvalAsked,
  approvalDecided,
  capture,
  collect,
  DENY_TEXT,
  errorFinish,
  ENVIRONMENT_FIXTURE,
  execution,
  FILTERED_HISTORY_FIXTURE,
  FIXTURE_POLICY,
  makeHost,
  PENDING_ACTION,
  PROJECT_INSTRUCTIONS_FIXTURE,
  reasoningDelta,
  reviewMessageTexts,
  reviewOptions,
  reviewUserText,
  runExecution,
  stopFinish,
  streamOf,
  textDelta,
  toolResultEvent,
} from './support/review-fixtures.ts'

/** The first held record, asserting it exists. */
function firstRecord(host: ReviewCaptureHost) {
  const record = host.buffer.all()[0]
  expect(record).toBeDefined()
  if (record === undefined) throw new Error('expected one record')
  return record
}

const allowedChunks: readonly StreamChunk[] = [textDelta(ALLOW_TEXT), stopFinish()]

describe('review request fingerprint', () => {
  it('matches the official reviewer shape and keeps every section verbatim', () => {
    const userText = reviewUserText()
    const match = matchReviewRequest(reviewOptions({ userText }))
    expect(match.kind).toBe('match')
    if (match.kind !== 'match') return
    expect(match.requestText).toBe(userText)
    expect(match.sections.policy).toBe(FIXTURE_POLICY)
    expect(match.sections.environment).toEqual({ cwd: '/work' })
    expect(match.sections.pendingAction).toMatchObject({
      mode: 'native',
      name: 'read_file',
      arguments: { path: 'README.md' },
    })
  })

  it('matches the multi-root fork shape and preserves its extra entries', () => {
    const userText = reviewUserText({ fork: true })
    const match = matchReviewRequest(reviewOptions({ userText }))
    expect(match.kind).toBe('match')
    if (match.kind !== 'match') return
    expect(match.sections.environment).toMatchObject({
      cwd: '/work',
      multiRoot: { environment: { roots: [{ path: '/work', access: 'read-write' }] } },
    })
    const instructions = match.sections.projectInstructions as readonly { kind: string }[]
    expect(instructions.map(entry => entry.kind)).toContain('current-root-instructions')
  })

  it('matches the messages protocol and rebuilds the pending action from its schema item', () => {
    const texts = reviewMessageTexts()
    const match = matchReviewRequest(reviewOptions({
      messages: texts.map(text => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })),
    }))
    expect(match.kind).toBe('match')
    if (match.kind !== 'match') return
    expect(match.requestText).toBe(texts.join('\n\n'))
    expect(match.sections.protocol).toBe('messages')
    expect(match.sections.environment).toEqual({ cwd: '/work' })
    expect(match.sections.projectInstructions).toBeUndefined()
    expect(match.sections.filteredHistory).toBeUndefined()
    expect(match.sections.history).toHaveLength(4)
    expect(match.sections.pendingAction).toMatchObject({
      kind: 'tool-call',
      role: 'fact',
      mode: 'native',
      name: 'read_file',
      description: 'Read one project file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      arguments: { path: 'README.md' },
    })
  })

  it('keeps an unparsable pending arguments string verbatim instead of guessing', () => {
    const texts = reviewMessageTexts({ pendingArguments: 'not-json' })
    const match = matchReviewRequest(reviewOptions({
      messages: texts.map(text => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })),
    }))
    expect(match.kind).toBe('match')
    if (match.kind !== 'match') return
    expect(match.sections.pendingAction.arguments).toBe('not-json')
  })

  const suspectedMessages: readonly [string, GenerateOptions][] = [
    ['a first message without the ENVIRONMENT marker', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'CONTEXT\n{"cwd":"/work"}' }] },
        { role: 'user', content: [{ type: 'text', text: '{"kind":"tool-call","role":"fact","mode":"native","name":"read_file","arguments":"{}"}' }] },
      ],
    })],
    ['a non-JSON ENVIRONMENT body', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\nnot-json' }] },
        { role: 'user', content: [{ type: 'text', text: '{"kind":"tool-call","role":"fact","mode":"native","name":"read_file","arguments":"{}"}' }] },
      ],
    })],
    ['a history message of an unknown kind', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n{"cwd":"/work"}' }] },
        { role: 'user', content: [{ type: 'text', text: '{"kind":"surprise"}' }] },
        { role: 'user', content: [{ type: 'text', text: '{"kind":"tool-call","role":"fact","mode":"native","name":"read_file","arguments":"{}"}' }] },
      ],
    })],
    ['a last message that is not the pending tool call', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n{"cwd":"/work"}' }] },
        { role: 'user', content: [{ type: 'text', text: '{"kind":"user-message","role":"constraint","source":{"kind":"user"},"content":[]}' }] },
      ],
    })],
    ['a non-user history message', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n{"cwd":"/work"}' }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"kind":"tool-call"}' }] },
      ],
    })],
  ]

  it.each(suspectedMessages)('counts %s as suspected, never as a match', (_label, options) => {
    expect(matchReviewRequest(options).kind).toBe('suspected')
  })

  it('does not match an ordinary conversation', () => {
    expect(matchReviewRequest(reviewOptions({ system: null })).kind).toBe('none')
    expect(matchReviewRequest(reviewOptions({ system: 'You are a helpful assistant.' })).kind).toBe('none')
  })

  const suspected: readonly [string, GenerateOptions][] = [
    ['a non-zero temperature', reviewOptions({ temperature: 1 })],
    ['a compaction purpose', reviewOptions({ purpose: 'compaction' })],
    ['a session-title purpose', reviewOptions({ purpose: 'session-title' })],
    ['a session identity', reviewOptions({ sessionId: 'session-1' })],
    ['two messages', reviewOptions({
      messages: [
        { role: 'user', content: [{ type: 'text', text: reviewUserText() }] },
        { role: 'user', content: [{ type: 'text', text: reviewUserText() }] },
      ],
    })],
    ['a missing section header', reviewOptions({ userText: reviewUserText({ omit: ['PENDING_ACTION'] }) })],
    ['a policy header without the rest of the shape', reviewOptions({ userText: 'nothing review-shaped here' })],
  ]

  it.each(suspected)('counts %s as suspected, never as a match', (_label, options) => {
    expect(matchReviewRequest(options).kind).toBe('suspected')
  })

  it('does not record an ordinary stream and does not count it as suspected', async () => {
    const host = makeHost()
    const seen = await capture(host, reviewOptions({ system: 'ordinary prompt' }), allowedChunks)
    expect(seen).toEqual(allowedChunks)
    expect(host.buffer.size).toBe(0)
    expect(host.diagnostics.suspectedReviewStreams).toBe(0)
  })

  it('counts a suspected stream but records nothing and leaves the stream untouched', async () => {
    const host = makeHost()
    const seen = await capture(host, reviewOptions({ temperature: 1 }), allowedChunks)
    expect(seen).toEqual(allowedChunks)
    expect(host.buffer.size).toBe(0)
    expect(host.diagnostics.suspectedReviewStreams).toBe(1)
  })
})

describe('captured record fidelity', () => {
  it('keeps the policy, request text, parsed sections, and raw output', async () => {
    const host = makeHost()
    const seen = await capture(host)
    expect(seen).toEqual([...allowedChunks])

    const record = firstRecord(host)
    expect(record.id).toBe('review-1')
    expect(record.capturedAt).toBe('2026-10-20T12:00:00.000Z')
    expect(record.provider).toBe('deepseek')
    expect(record.model).toBe('deepseek-chat')
    expect(record.requestText).toBe(reviewUserText())
    expect(record.sections.policy).toBe(FIXTURE_POLICY)
    expect(record.sections.environment).toEqual(ENVIRONMENT_FIXTURE)
    expect(record.sections.projectInstructions).toEqual(PROJECT_INSTRUCTIONS_FIXTURE)
    expect(record.sections.filteredHistory).toEqual(FILTERED_HISTORY_FIXTURE)
    expect(record.sections.pendingAction).toMatchObject(PENDING_ACTION)
    expect(record.output).toEqual({ risk: 'low', decision: 'allow', rawText: ALLOW_TEXT })
    expect(record.reasoning).toEqual([])
    expect(record.finish).toBeUndefined()
    expect(record.correlation).toBeUndefined()
  })

  it('freezes the record and every nested section as soon as it is buffered', async () => {
    const host = makeHost()
    await capture(host)
    const record = firstRecord(host)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.sections)).toBe(true)
    expect(Object.isFrozen(record.sections.pendingAction)).toBe(true)
    expect(Object.isFrozen(record.sections.filteredHistory)).toBe(true)
    expect(Object.isFrozen(record.output)).toBe(true)
  })

  it('captures a messages-protocol request and correlates it to its execution', async () => {
    const host = makeHost()
    const messages = reviewMessageTexts().map(text => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
    }))
    await capture(host, reviewOptions({ messages }))
    const record = firstRecord(host)
    expect(record.sections.protocol).toBe('messages')
    expect(Array.isArray(record.sections.history)).toBe(true)
    expect(Object.isFrozen(record.sections.history)).toBe(true)
    await expect(runExecution(host)).resolves.toEqual({ kind: 'allow' })
    expect(firstRecord(host).correlation).toEqual({
      sessionId: 'session-1',
      callId: 'call-1',
      downstreamDecision: 'allow',
    })
  })

  it('keeps reasoning blocks in order and uses the final text block as rawText', async () => {
    const host = makeHost()
    await capture(host, reviewOptions(), [
      reasoningDelta('first thought', 0),
      reasoningDelta(' continued', 0),
      reasoningDelta('second thought', 1),
      textDelta(ALLOW_TEXT, 2),
      stopFinish(),
    ])
    const record = firstRecord(host)
    expect(record.reasoning).toEqual(['first thought continued', 'second thought'])
    expect(record.output.rawText).toBe(ALLOW_TEXT)
  })

  it('treats a block-end payload as authoritative', async () => {
    const host = makeHost()
    await capture(host, reviewOptions(), [
      { type: 'block-start', index: 0, blockType: 'text' },
      textDelta('partial'),
      { type: 'block-end', index: 0, block: { type: 'text', text: ALLOW_TEXT } },
      stopFinish(),
    ])
    expect(firstRecord(host).output.rawText).toBe(ALLOW_TEXT)
    expect(firstRecord(host).output.decision).toBe('allow')
  })

  it('captures a deny verdict and its reason', async () => {
    const host = makeHost()
    await capture(host, reviewOptions(), [textDelta(DENY_TEXT), stopFinish()])
    const record = firstRecord(host)
    expect(record.output).toMatchObject({
      risk: 'high',
      decision: 'deny',
      reason: 'sends credentials to an external host',
      rawText: DENY_TEXT,
    })
  })

  const badProtocols: readonly [string, string][] = [
    ['invalid JSON', 'not json'],
    ['low-risk deny', '{"risk":"low","decision":"deny"}'],
    ['allow with a reason', '{"risk":"low","decision":"allow","reason":"why"}'],
    ['a duplicated member', '{"risk":"low","decision":"allow","decision":"allow"}'],
    ['an unknown member', '{"risk":"low","decision":"allow","extra":true}'],
  ]

  it.each(badProtocols)('records %s as decision error with the raw text', async (_label, rawText) => {
    const host = makeHost()
    await capture(host, reviewOptions(), [textDelta(rawText), stopFinish()])
    const record = firstRecord(host)
    expect(record.output.decision).toBe('error')
    expect(record.output.risk).toBeUndefined()
    expect(record.output.reason).toBeUndefined()
    expect(record.output.rawText).toBe(rawText)
  })

  it('records an error finish and forwards the chunk unchanged', async () => {
    const host = makeHost()
    const chunks = [textDelta(ALLOW_TEXT), errorFinish('RATE_LIMIT', 'provider failed')]
    const seen = await capture(host, reviewOptions(), chunks)
    expect(seen).toEqual(chunks)
    expect(firstRecord(host).finish).toEqual({
      kind: 'error',
      code: 'RATE_LIMIT',
      message: 'provider failed',
    })
  })

  it('records an aborted finish and forwards the chunk unchanged', async () => {
    const host = makeHost()
    const chunks = [textDelta(ALLOW_TEXT), abortedFinish('ABORTED', 'stream aborted')]
    const seen = await capture(host, reviewOptions(), chunks)
    expect(seen).toEqual(chunks)
    expect(firstRecord(host).finish).toEqual({
      kind: 'aborted',
      code: 'ABORTED',
      message: 'stream aborted',
    })
  })

  it('keeps a record when the stream ends without a terminal finish', async () => {
    const host = makeHost()
    await capture(host, reviewOptions(), [textDelta(ALLOW_TEXT)])
    const record = firstRecord(host)
    expect(record.finish).toBeUndefined()
    expect(record.output.rawText).toBe(ALLOW_TEXT)
  })
})

describe('tee defensive boundary', () => {
  it('contains recording-path failures and still forwards every chunk', async () => {
    let finished = 0
    const sink: ReviewCaptureSink = {
      push() {
        throw new Error('recording push failed')
      },
      finish() {
        finished += 1
        throw new Error('recording finish failed')
      },
    }
    const chunks = [reasoningDelta('think'), textDelta(ALLOW_TEXT, 1), errorFinish()]
    const seen = await collect(teeReviewStream(streamOf(...chunks), sink))
    expect(seen).toEqual(chunks)
    expect(finished).toBe(1)
  })

  it('propagates an upstream stream failure after finalizing the recording', async () => {
    let finished = false
    const sink: ReviewCaptureSink = {
      push() {},
      finish() {
        finished = true
      },
    }
    async function* failing(): AsyncGenerator<StreamChunk> {
      yield textDelta(ALLOW_TEXT)
      throw new Error('upstream exploded')
    }
    await expect(collect(teeReviewStream(failing(), sink))).rejects.toThrow('upstream exploded')
    expect(finished).toBe(true)
  })

  it('keeps reviewing even when the record buffer rejects the record', async () => {
    const host = makeHost()
    vi.spyOn(host.buffer, 'add').mockImplementation(() => {
      throw new Error('buffer refused the record')
    })
    const chunks = [textDelta(ALLOW_TEXT), errorFinish()]
    const seen = await capture(host, reviewOptions(), chunks)
    expect(seen).toEqual(chunks)
    expect(host.buffer.size).toBe(0)
  })
})

describe('pre-execute correlation', () => {
  it('correlates one record with the one matching exec and records the downstream decision', async () => {
    const host = makeHost()
    await capture(host)

    const decision = await runExecution(host)
    expect(decision).toEqual({ kind: 'allow' })
    expect(firstRecord(host).correlation).toEqual({
      sessionId: 'session-1',
      callId: 'call-1',
      downstreamDecision: 'allow',
    })
  })

  it('records a downstream ask rather than rewriting it', async () => {
    const host = makeHost()
    await capture(host)
    const downstream: PreToolDecision = { kind: 'ask', reason: 'needs approval' }
    const decision = await runExecution(host, execution(), downstream)
    expect(decision).toBe(downstream)
    expect(firstRecord(host).correlation?.downstreamDecision).toBe('ask')
  })

  it('records a downstream deny rather than treating it as the reviewer verdict', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host, execution(), { kind: 'deny', reason: 'policy' })
    const record = firstRecord(host)
    expect(record.output.decision).toBe('allow')
    expect(record.correlation?.downstreamDecision).toBe('deny')
  })

  it('refuses to correlate when two identical records match one exec', async () => {
    const host = makeHost()
    await capture(host)
    await capture(host)
    await runExecution(host)
    for (const record of host.buffer.all()) expect(record.correlation).toBeUndefined()
  })

  it('refuses to correlate two identical in-flight execs with one record', async () => {
    const host = makeHost()
    await capture(host)

    const first = Promise.withResolvers<PreToolDecision>()
    const second = Promise.withResolvers<PreToolDecision>()
    const firstRun = host.preExecute(execution({ callId: 'call-1' }), () => first.promise)
    const secondRun = host.preExecute(execution({ callId: 'call-2' }), () => second.promise)

    first.resolve({ kind: 'allow' })
    await firstRun
    second.resolve({ kind: 'allow' })
    await secondRun

    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('does not correlate an exec with different arguments', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host, execution({ arguments: { path: 'other.md' } }))
    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('correlates a PTC inner call only with its ptc-inner pending action', async () => {
    const host = makeHost()
    const pending = {
      mode: 'ptc-inner',
      name: 'read_file',
      description: 'Read one project file',
      parameters: { type: 'object' },
      arguments: { path: 'README.md' },
    }
    await capture(host, reviewOptions({ userText: reviewUserText({ pendingAction: pending }) }))
    await runExecution(host, execution({ parent: { token: true }, callId: 'call-sub-1' }))
    expect(firstRecord(host).correlation).toEqual({
      sessionId: 'session-1',
      callId: 'call-sub-1',
      downstreamDecision: 'allow',
    })
  })

  it('does not correlate when the session is not on the Auto preset', async () => {
    const host = makeHost({ current: () => 'workspace-write' })
    await capture(host)
    await runExecution(host)
    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('does not correlate an agent-less exec', async () => {
    const host = makeHost()
    await capture(host)
    const { agent: _agent, ...withoutAgent } = execution()
    await runExecution(host, withoutAgent)
    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('does not correlate when the preset lookup throws', async () => {
    const host = makeHost({
      current: () => {
        throw new Error('preset lookup failed')
      },
    })
    await capture(host)
    await expect(runExecution(host)).resolves.toEqual({ kind: 'allow' })
    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('propagates a downstream failure unchanged and leaves the record unassociated', async () => {
    const host = makeHost()
    await capture(host)
    await expect(host.preExecute(execution(), async () => {
      throw new Error('downstream failed')
    })).rejects.toThrow('downstream failed')
    expect(firstRecord(host).correlation).toBeUndefined()
  })

  it('keeps the verbatim denial info a downstream deny carried', async () => {
    const host = makeHost()
    await capture(host)
    const denied: PreToolDecision = {
      kind: 'deny',
      reason: 'Auto review rejected tool "read_file"; its body was not executed',
      info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
    }
    const decision = await runExecution(host, execution(), denied)
    expect(decision).toBe(denied)
    const record = firstRecord(host)
    expect(record.correlation?.downstreamDecision).toBe('deny')
    expect(record.correlation?.denialInfo).toEqual({
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
    })
  })
})

describe('host disposition evidence', () => {
  it('attaches the logged denial identity to the correlated record', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-1', toolResultEvent('call-1', {
      isError: true,
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
      reason: 'sends credentials to an external host',
    }))
    expect(firstRecord(host).hostOutcome?.toolResult).toEqual({
      isError: true,
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
      reason: 'sends credentials to an external host',
    })
  })

  it('attaches a clean tool result as an executed outcome', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-1', toolResultEvent('call-1'))
    expect(firstRecord(host).hostOutcome?.toolResult).toEqual({ isError: false })
  })

  it('merges evidence that arrives before the anchor exists (approval inside the waterfall)', async () => {
    const host = makeHost()
    await capture(host)
    await host.preExecute(execution(), async () => {
      // The upstream `ask` logs the approval pair before `next()` resolves —
      // the record does not carry its anchor yet at that point.
      host.observeSessionEvent('session-1', approvalAsked('approval-1', 'call-1'))
      host.observeSessionEvent('session-1', approvalDecided('approval-1', 'allowed-once'))
      return { kind: 'ask' }
    })
    expect(firstRecord(host).correlation?.downstreamDecision).toBe('ask')
    expect(firstRecord(host).hostOutcome?.approval).toEqual({ outcome: 'allowed-once' })
  })

  it('attaches the approval audit pair asked then decided', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-1', approvalAsked('approval-1', 'call-1'))
    expect(firstRecord(host).hostOutcome?.approval).toEqual({})
    host.observeSessionEvent('session-1', approvalDecided('approval-1', 'allowed-once'))
    expect(firstRecord(host).hostOutcome?.approval).toEqual({ outcome: 'allowed-once' })
  })

  it('refuses evidence on an uncorrelated record', async () => {
    const host = makeHost()
    await capture(host)
    host.observeSessionEvent('session-1', toolResultEvent('call-1', {
      isError: true,
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
    }))
    host.observeSessionEvent('session-1', approvalAsked('approval-1', 'call-1'))
    expect(firstRecord(host).hostOutcome).toBeUndefined()
  })

  it('ignores events for a callId the anchor never pinned', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-1', toolResultEvent('call-other', { isError: true, code: 'X' }))
    host.observeSessionEvent('session-1', approvalDecided('approval-unknown', 'rejected'))
    expect(firstRecord(host).hostOutcome).toBeUndefined()
  })

  it('ignores a result logged under a different session', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-2', toolResultEvent('call-1', { isError: true, code: 'AUTO_REVIEW_DENIED' }))
    expect(firstRecord(host).hostOutcome).toBeUndefined()
  })

  it('survives a malformed event without touching the record', async () => {
    const host = makeHost()
    await capture(host)
    await runExecution(host)
    host.observeSessionEvent('session-1', { type: 'tool/result', data: 'not-an-object' })
    host.observeSessionEvent('session-1', { type: 'approval/asked', data: { id: 7 } })
    expect(firstRecord(host).hostOutcome).toBeUndefined()
  })
})
