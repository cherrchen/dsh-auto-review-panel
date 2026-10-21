/**
 * Shared review-capture fixtures.
 *
 * The request text mirrors the upstream reviewer's rendering shape (four
 * headers, pretty-printed JSON bodies) without copying the private policy
 * body: the fingerprint only reads the fixed header, so a short fixture policy
 * keeps this repository from maintaining a second copy of upstream text.
 *
 * @module tests/support/review-fixtures
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { ReviewCaptureHost } from '../../src/host.ts'
import type { ReviewExecutionLike } from '../../src/host.ts'
import type { ReviewHistory } from '../../src/history/contract.ts'

/** A fixture policy with the fixed first line the fingerprint reads. */
export const FIXTURE_POLICY = `REVIEW_POLICY
You are the final authorization reviewer for exactly one pending tool call.
Fixture body: the fingerprint reads only the first line.
`

/** Canonical allow response. */
export const ALLOW_TEXT = '{"risk":"low","decision":"allow"}'

/** Canonical deny response with a reason. */
export const DENY_TEXT = '{"risk":"high","decision":"deny","reason":"sends credentials to an external host"}'

/** Default PENDING_ACTION for the official reviewer shape. */
export const PENDING_ACTION = {
  mode: 'native',
  name: 'read_file',
  description: 'Read one project file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  arguments: { path: 'README.md' },
} as const

/** Options for building one reviewer-shaped user message. */
export interface ReviewUserTextOptions {
  /** Use the multi-root fork's extra ENVIRONMENT/PROJECT_INSTRUCTIONS shape. */
  readonly fork?: boolean
  /** Section headers to omit, for negative fingerprint cases. */
  readonly omit?: readonly string[]
  readonly pendingAction?: unknown
}

/** Pretty-print one JSON value the way the reviewer renders sections. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Default ENVIRONMENT for the official shape. */
export const ENVIRONMENT_FIXTURE = { cwd: '/work' } as const

/** Default PROJECT_INSTRUCTIONS for the official shape. */
export const PROJECT_INSTRUCTIONS_FIXTURE = [{
  kind: 'user-message',
  role: 'constraint',
  source: { kind: 'agent-instructions' },
  content: [{ type: 'text', text: 'Use spaces for indentation.' }],
}] as const

/** Default FILTERED_HISTORY for the official shape. */
export const FILTERED_HISTORY_FIXTURE = [{
  kind: 'tool-call',
  role: 'fact',
  mode: 'native',
  name: 'list_files',
  arguments: '{"path":"."}',
}, {
  kind: 'user-message',
  role: 'human-instruction',
  source: { kind: 'user', rpcId: 'rpc-1' },
  content: [{ type: 'text', text: 'Please read the README.' }],
}] as const

/**
 * Build the four-section reviewer user text.
 * @param options - shape variations.
 * @returns the exact text the reviewer would send.
 */
export function reviewUserText(options: ReviewUserTextOptions = {}): string {
  const environment = options.fork
    ? {
        cwd: '/work',
        multiRoot: {
          environment: {
            roots: [{ path: '/work', access: 'read-write' }],
          },
          executionFence: 'Root membership is not human authorization.',
        },
      }
    : ENVIRONMENT_FIXTURE
  const projectInstructions = options.fork
    ? [
        ...PROJECT_INSTRUCTIONS_FIXTURE,
        {
          kind: 'current-root-instructions',
          role: 'constraint',
          source: { kind: 'multi-root-workspace', snapshot: 'current' },
          content: [{ type: 'text', text: 'The current root is read-write.' }],
        },
      ]
    : PROJECT_INSTRUCTIONS_FIXTURE
  const filteredHistory = FILTERED_HISTORY_FIXTURE
  const pendingAction = options.pendingAction ?? PENDING_ACTION
  const sections: readonly [string, unknown][] = [
    ['ENVIRONMENT', environment],
    ['PROJECT_INSTRUCTIONS', projectInstructions],
    ['FILTERED_HISTORY', filteredHistory],
    ['PENDING_ACTION', pendingAction],
  ]
  return sections
    .filter(([header]) => !options.omit?.includes(header))
    .map(([header, value]) => `${header}\n\n${json(value)}`)
    .join('\n\n')
}

/** Options accepted by {@link reviewOptions}. */
export interface ReviewOptionsOverrides {
  readonly userText?: string
  /** `null` omits `system` entirely; `undefined` uses {@link FIXTURE_POLICY}. */
  readonly system?: string | null
  readonly temperature?: number
  readonly sessionId?: string
  readonly purpose?: 'compaction' | 'session-title'
  readonly messages?: GenerateOptions['messages']
  readonly provider?: string
  readonly model?: string
}

/**
 * Build one reviewer-shaped request.
 * @param overrides - fields to vary for fingerprint tests.
 * @returns the request object.
 */
export function reviewOptions(overrides: ReviewOptionsOverrides = {}): GenerateOptions {
  const system = overrides.system === undefined ? FIXTURE_POLICY : overrides.system
  return {
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    ...(system === null ? {} : { system }),
    messages: overrides.messages ?? [{
      role: 'user',
      content: [{ type: 'text', text: overrides.userText ?? reviewUserText() }],
    }],
    temperature: overrides.temperature ?? 0,
    ...(overrides.sessionId === undefined
      ? {}
      : { sessionId: overrides.sessionId as GenerateOptions['sessionId'] }),
    ...(overrides.purpose === undefined ? {} : { purpose: overrides.purpose }),
  }
}

/** One text delta chunk. */
export function textDelta(text: string, index = 0): StreamChunk {
  return { type: 'text-delta', index, text }
}

/** One reasoning delta chunk. */
export function reasoningDelta(text: string, index = 0): StreamChunk {
  return { type: 'reasoning-delta', index, text }
}

/** A normal `stop` finish chunk. */
export function stopFinish(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } }
}

/** An `error` finish chunk. */
export function errorFinish(code = 'RATE_LIMIT', message = 'provider failed'): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/** An `aborted` finish chunk. */
export function abortedFinish(code = 'ABORTED', message = 'stream aborted'): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { code, message } } }
}

/** Yield a fixed chunk list as one async stream. */
export async function* streamOf(...chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

/** Collect one async iterable. */
export async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Options for {@link makeHost}. */
export interface HostFixtureOptions {
  readonly names?: readonly string[]
  readonly current?: (session: Session) => string
  readonly sessions?: Map<string, unknown>
  readonly globalCapacity?: number
  readonly sessionCapacity?: number
  /** The registry names the fixture host reports; omitted leaves the status unread. */
  readonly toolNames?: readonly string[]
  /** The optional persistence seam; omitted leaves the host memory-only. */
  readonly history?: ReviewHistory
}

/**
 * Build a host core with deterministic identity and timestamps.
 * @param options - service fakes and buffer capacities.
 * @returns the host.
 */
export function makeHost(options: HostFixtureOptions = {}): ReviewCaptureHost {
  const sessions = options.sessions ?? new Map<string, unknown>([
    ['session-1', {
      id: 'session-1',
      header: { createdAt: 1760000000000, isSeeded: false, cwd: '/work' },
    }],
  ])
  return new ReviewCaptureHost({
    permissionPresets: {
      names: options.names ?? ['auto', 'workspace-write'],
      current: options.current ?? (() => 'auto'),
    },
    sessions: {
      get: id => sessions.get(String(id)) as Session | undefined,
    },
    autoPreset: 'auto',
    runCodeName: 'run_code',
    now: () => '2026-10-20T12:00:00.000Z',
    createId: (() => {
      let next = 0
      return () => `review-${++next}`
    })(),
    ...(options.toolNames === undefined
      ? {}
      : { listToolNames: () => options.toolNames ?? [] }),
    ...(options.globalCapacity === undefined ? {} : { globalCapacity: options.globalCapacity }),
    ...(options.sessionCapacity === undefined ? {} : { sessionCapacity: options.sessionCapacity }),
    ...(options.history === undefined ? {} : { history: options.history }),
  })
}

/**
 * Run one stream through the host and collect exactly what the consumer saw.
 * @param host - the capture host.
 * @param options - the review-shaped request.
 * @param chunks - the upstream response.
 * @returns the forwarded chunks.
 */
export function capture(
  host: ReviewCaptureHost,
  options: GenerateOptions = reviewOptions(),
  chunks: readonly StreamChunk[] = [textDelta(ALLOW_TEXT), stopFinish()],
): Promise<StreamChunk[]> {
  return collect(host.stream(options, () => streamOf(...chunks)))
}

/** Build one reviewed execution. */
export function execution(overrides: Partial<ReviewExecutionLike> = {}): ReviewExecutionLike {
  return {
    name: 'read_file',
    arguments: { path: 'README.md' },
    callId: 'call-1',
    agent: { session: { id: 'session-1' } },
    ...overrides,
  }
}

/** Run one execution through the correlation anchor. */
export function runExecution(
  host: ReviewCaptureHost,
  exec: ReviewExecutionLike = execution(),
  decision: PreToolDecision = { kind: 'allow' },
): Promise<PreToolDecision> {
  return host.preExecute(exec, async () => decision)
}

/** A `tool/result` Session event for one callId. */
export function toolResultEvent(
  callId: string,
  options: { readonly isError?: boolean; readonly name?: string; readonly code?: string; readonly reason?: string } = {},
): { type: 'tool/result'; data: unknown } {
  const isError = options.isError ?? false
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, content: [], isError },
      ...(isError ? { error: { name: options.name, code: options.code, reason: options.reason } } : {}),
    },
  }
}

/** An `approval/asked` Session event for one callId. */
export function approvalAsked(id: string, callId: string): { type: 'approval/asked'; data: unknown } {
  return { type: 'approval/asked', data: { id, toolName: 'read_file', callId } }
}

/** An `approval/decided` Session event closing one request. */
export function approvalDecided(id: string, outcome: string): { type: 'approval/decided'; data: unknown } {
  return { type: 'approval/decided', data: { id, outcome } }
}
