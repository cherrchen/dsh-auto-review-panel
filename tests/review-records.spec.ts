/**
 * Buffer invariants: two capacities, newest-first reads, session filtering that
 * never hides uncorrelated records, and immutability of anything already
 * handed to a reader.
 */

import { describe, expect, it } from 'vitest'
import type { ReviewRecord } from '../src/contract.ts'
import {
  DEFAULT_GLOBAL_CAPACITY,
  DEFAULT_SESSION_CAPACITY,
  ReviewRecordBuffer,
  summarizeRecord,
} from '../src/records.ts'

/** Build one complete record, optionally already correlated. */
function record(id: string, sessionId?: string): ReviewRecord {
  return {
    id,
    capturedAt: `2026-10-20T12:00:0${id.slice(-1)}.000Z`,
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestText: `request ${id}`,
    sections: {
      policy: 'REVIEW_POLICY',
      environment: { cwd: '/work' },
      projectInstructions: [],
      filteredHistory: [],
      pendingAction: {
        mode: 'native',
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    },
    reasoning: [],
    output: { risk: 'low', decision: 'allow', rawText: '{"risk":"low","decision":"allow"}' },
    ...(sessionId === undefined
      ? {}
      : { correlation: { sessionId, callId: `call-${id}`, downstreamDecision: 'allow' } }),
  }
}

describe('ring capacities', () => {
  it('defaults to 50 per session and 200 globally', () => {
    const buffer = new ReviewRecordBuffer()
    for (let index = 0; index < DEFAULT_GLOBAL_CAPACITY + 5; index += 1) {
      buffer.add(record(`u${index}`))
    }
    expect(buffer.size).toBe(DEFAULT_GLOBAL_CAPACITY)
    expect(buffer.get('u0')).toBeUndefined()

    for (let index = 0; index < DEFAULT_SESSION_CAPACITY + 5; index += 1) {
      buffer.add(record(`r${index}`, 'session-1'))
    }
    expect(buffer.sessionSize('session-1')).toBe(DEFAULT_SESSION_CAPACITY)
    expect(buffer.size).toBeLessThanOrEqual(DEFAULT_GLOBAL_CAPACITY)
  })

  it('drops the oldest record when the global cap is exceeded', () => {
    const buffer = new ReviewRecordBuffer({ globalCapacity: 3 })
    for (const id of ['r1', 'r2', 'r3', 'r4']) buffer.add(record(id))
    expect(buffer.size).toBe(3)
    expect(buffer.get('r1')).toBeUndefined()
    expect(buffer.list().map(entry => entry.id)).toEqual(['r4', 'r3', 'r2'])
  })

  it('drops the oldest record of a session when its cap is exceeded', () => {
    const buffer = new ReviewRecordBuffer({ globalCapacity: 10, sessionCapacity: 2 })
    const records = ['r1', 'r2', 'r3'].map(id => record(id))
    for (const entry of records) buffer.add(entry)
    for (const entry of records) {
      const stored = buffer.get(entry.id)
      expect(stored).toBeDefined()
      if (stored !== undefined) {
        buffer.correlate(stored.id, {
          sessionId: 'session-1',
          callId: `call-${stored.id}`,
          downstreamDecision: 'allow',
        })
      }
    }
    expect(buffer.sessionSize('session-1')).toBe(2)
    expect(buffer.get('r1')).toBeUndefined()
    expect(buffer.list('session-1').map(entry => entry.id)).toEqual(['r3', 'r2'])
  })

  it('counts uncorrelated records against the global cap only', () => {
    const buffer = new ReviewRecordBuffer({ globalCapacity: 10, sessionCapacity: 1 })
    buffer.add(record('r1', 'session-1'))
    buffer.add(record('r2'))
    buffer.add(record('r3'))
    expect(buffer.sessionSize('session-1')).toBe(1)
    expect(buffer.size).toBe(3)
  })
})

describe('session filtering', () => {
  it('always includes uncorrelated records, newest first', () => {
    const buffer = new ReviewRecordBuffer({ globalCapacity: 10, sessionCapacity: 10 })
    buffer.add(record('r1', 'session-1'))
    buffer.add(record('r2', 'session-2'))
    buffer.add(record('r3'))
    expect(buffer.list('session-1').map(entry => entry.id)).toEqual(['r3', 'r1'])
    expect(buffer.list('session-2').map(entry => entry.id)).toEqual(['r3', 'r2'])
    expect(buffer.list().map(entry => entry.id)).toEqual(['r3', 'r2', 'r1'])
  })
})

describe('immutability', () => {
  it('freezes a record on insertion', () => {
    const buffer = new ReviewRecordBuffer()
    const stored = buffer.add(record('r1'))
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.sections)).toBe(true)
    expect(Object.isFrozen(stored.output)).toBe(true)
  })

  it('replaces a record to correlate it and leaves the previous snapshot stable', () => {
    const buffer = new ReviewRecordBuffer()
    const original = buffer.add(record('r1'))
    expect(original.correlation).toBeUndefined()
    const updated = buffer.correlate('r1', {
      sessionId: 'session-1',
      callId: 'call-1',
      downstreamDecision: 'deny',
    })
    expect(updated).toBeDefined()
    expect(updated?.correlation).toEqual({
      sessionId: 'session-1',
      callId: 'call-1',
      downstreamDecision: 'deny',
    })
    expect(original.correlation).toBeUndefined()
    expect(Object.isFrozen(updated)).toBe(true)
    expect(buffer.get('r1')).toBe(updated)
  })

  it('keeps the first correlation anchor', () => {
    const buffer = new ReviewRecordBuffer()
    buffer.add(record('r1'))
    buffer.correlate('r1', { sessionId: 'session-1', callId: 'call-1', downstreamDecision: 'allow' })
    const second = buffer.correlate('r1', {
      sessionId: 'session-2',
      callId: 'call-2',
      downstreamDecision: 'deny',
    })
    expect(second?.correlation?.sessionId).toBe('session-1')
  })
})

describe('list rows', () => {
  it('carry the five compact fields plus correlated state', () => {
    const buffer = new ReviewRecordBuffer()
    const stored = buffer.add(record('r1', 'session-1'))
    expect(summarizeRecord(stored)).toEqual({
      id: 'r1',
      capturedAt: '2026-10-20T12:00:01.000Z',
      action: { name: 'read_file', mode: 'native' },
      risk: 'low',
      decision: 'allow',
      correlated: true,
    })
  })

  it('truncate a long reason without inventing text', () => {
    const buffer = new ReviewRecordBuffer()
    const long = 'x'.repeat(200)
    const base = record('r1')
    const stored = buffer.add({
      ...base,
      output: { risk: 'high', decision: 'deny', reason: long, rawText: 'raw' },
    })
    const summary = summarizeRecord(stored)
    expect(summary.reason).toBe(`${'x'.repeat(157)}...`)
    expect(summary.reason?.length).toBe(160)
  })

  it('carry an abnormal finish', () => {
    const buffer = new ReviewRecordBuffer()
    const base = record('r1')
    const stored = buffer.add({
      ...base,
      finish: { kind: 'aborted', code: 'ABORTED', message: 'stream aborted' },
    })
    expect(summarizeRecord(stored).finish).toEqual({
      kind: 'aborted',
      code: 'ABORTED',
      message: 'stream aborted',
    })
  })
})
