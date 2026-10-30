/**
 * Structural fingerprint of the upstream Auto Review request.
 *
 * Auto Review sets no session identity and no `purpose` on its request, so a
 * review stream is indistinguishable from an ordinary one by types alone. The
 * fingerprint below is the supported discriminator: it reads the request's
 * SHAPE — the fixed policy header, `temperature: 0`, the absence of the
 * identity fields the reviewer never sets, and the request's user messages.
 * Two upstream renderings are recognized: the single message carrying the
 * four data-section headers (the `sections` protocol, rc.2–rc.5), and the
 * per-item user messages ending with the pending tool call (the `messages`
 * protocol, 0.2.2-alpha and later).
 *
 * This module is deliberately under `src/compat/`: the constants and the
 * parser are the version-coupled part of the capture path (ADR-0001, ADR-0003).
 * A miss is not an error — an ordinary request simply is not a review. A
 * request that starts with the policy header but fails the rest is reported as
 * `suspected`, so the host can count it for the upgrade lane without ever
 * showing it as a panel record.
 *
 * @module @dsh-electron/dsh-auto-review-panel/compat/review-fingerprint
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ReviewPendingAction, ReviewSections } from '../contract.ts'

/** First line of the fixed policy the reviewer sends as `options.system`. */
export const REVIEW_POLICY_HEADER = 'REVIEW_POLICY'

/** The four data-section headers, in their fixed order. */
export const REVIEW_SECTION_HEADERS = [
  'ENVIRONMENT',
  'PROJECT_INSTRUCTIONS',
  'FILTERED_HISTORY',
  'PENDING_ACTION',
] as const

/** The fixed temperature the reviewer sends. */
export const REVIEW_TEMPERATURE = 0

/**
 * The `ENVIRONMENT` marker the messages protocol puts at the head of its
 * first user message, followed by one JSON body line.
 */
const ENVIRONMENT_PATTERN = /^ENVIRONMENT\r?\n/u

/**
 * The history-item kinds the messages protocol emits: one JSON object per
 * user message, ending with the pending call. An unrecognized kind is a
 * `suspected` signal — exactly what the upgrade lane needs to notice.
 */
const HISTORY_ENTRY_KINDS = new Set(['user-message', 'tool-call', 'tool-schema'])

/** What the fingerprint learned about one stream request. */
export type ReviewRequestMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'suspected'; readonly reason: string }
  | {
    readonly kind: 'match'
    readonly requestText: string
    readonly sections: ReviewSections
  }

const SECTION_PATTERN = /^(ENVIRONMENT|PROJECT_INSTRUCTIONS|FILTERED_HISTORY|PENDING_ACTION)\r?$/gm

/**
 * Whether the system text begins with the fixed policy header.
 * @param system - the request's system prompt.
 * @returns true when the first line is exactly `REVIEW_POLICY`.
 */
function hasPolicyHeader(system: string): boolean {
  const firstLine = system.split('\n', 1)[0]
  return firstLine?.replace(/\r$/u, '') === REVIEW_POLICY_HEADER
}

/** Whether one unknown value is a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the four data sections out of the reviewer's single user text.
 * @param text - the user message text.
 * @returns the four parsed values, or a reason the text is not review-shaped.
 */
function parseSections(text: string): { readonly sections: Omit<ReviewSections, 'policy'> } | { readonly reason: string } {
  const matches = [...text.matchAll(SECTION_PATTERN)]
  if (matches.length !== REVIEW_SECTION_HEADERS.length) {
    return { reason: `expected ${REVIEW_SECTION_HEADERS.length} section headers, found ${matches.length}` }
  }
  for (const [index, expected] of REVIEW_SECTION_HEADERS.entries()) {
    const match = matches[index]
    if (match?.[1] !== expected) return { reason: `section ${index + 1} is not ${expected}` }
    if (match.index !== 0 && index === 0) return { reason: 'ENVIRONMENT does not start the user text' }
  }

  const values: unknown[] = []
  for (const [index, match] of matches.entries()) {
    const start = sectionBodyStart(text, (match.index ?? 0) + match[0].length)
    const end = matches[index + 1]?.index ?? text.length
    const body = text.slice(start, end).trim()
    try {
      values.push(JSON.parse(body))
    } catch {
      return { reason: `section ${REVIEW_SECTION_HEADERS[index]} is not JSON` }
    }
  }

  const [environment, projectInstructions, filteredHistory, pendingAction] = values
  return {
    sections: {
      environment,
      projectInstructions,
      filteredHistory,
      pendingAction: pendingActionOf(pendingAction),
    },
  }
}

/** Skip the blank separator between a section header and its JSON body. */
function sectionBodyStart(text: string, afterHeader: number): number {
  let index = afterHeader
  if (text[index] === '\r') index += 1
  if (text[index] === '\n') index += 1
  if (text[index] === '\r') index += 1
  if (text[index] === '\n') index += 1
  return index
}

/**
 * Keep the known PENDING_ACTION fields only when the JSON value actually
 * carried them; unknown fields stay for audit.
 * @param value - the parsed PENDING_ACTION value.
 * @returns the read-only action view.
 */
function pendingActionOf(value: unknown): ReviewPendingAction {
  if (!isRecord(value)) return {}
  const action: Record<string, unknown> = { ...value }
  if (action['mode'] !== 'native' && action['mode'] !== 'ptc-inner') delete action['mode']
  if (typeof action['name'] !== 'string') delete action['name']
  if (typeof action['description'] !== 'string') delete action['description']
  if (!isRecord(action['parameters'])) delete action['parameters']
  return action as ReviewPendingAction
}

/**
 * Read the raw `arguments` string the messages protocol logs, the way the
 * reviewer compares it: an empty string is no arguments, JSON parses to the
 * logged value, and an unparsable string stays verbatim — never guessed.
 * @param raw - the tool-call entry's `arguments` member.
 * @returns the value correlation keys compare against `exec.arguments`.
 */
function parseLoggedArguments(raw: string): unknown {
  if (raw === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Read the messages protocol's user texts (0.2.2-alpha and later): the first
 * is `ENVIRONMENT` plus its JSON body, each later message is one retained
 * Session item, and the last is the pending tool call. The pending action's
 * description and parameter schema come from the latest `tool-schema` item
 * with the same mode and name, mirroring the policy text.
 * @param texts - the per-message user texts, in request order.
 * @returns the parsed sections, or a reason the request is not review-shaped.
 */
function parseReviewMessages(texts: readonly string[]):
  { readonly sections: Omit<ReviewSections, 'policy' | 'protocol'> } | { readonly reason: string } {
  const environmentMatch = ENVIRONMENT_PATTERN.exec(texts[0] ?? '')
  if (environmentMatch === null) {
    return { reason: 'the first message is not the ENVIRONMENT message' }
  }
  let environment: unknown
  try {
    environment = JSON.parse(texts[0]!.slice(environmentMatch[0].length))
  } catch {
    return { reason: 'the ENVIRONMENT body is not JSON' }
  }

  const history: Record<string, unknown>[] = []
  for (const [index, text] of texts.slice(1).entries()) {
    let entry: unknown
    try {
      entry = JSON.parse(text)
    } catch {
      return { reason: `history message ${index + 2} is not JSON` }
    }
    if (!isRecord(entry) || typeof entry['kind'] !== 'string' || !HISTORY_ENTRY_KINDS.has(entry['kind'])) {
      return { reason: `history message ${index + 2} has an unknown kind` }
    }
    history.push(entry)
  }

  const pending = history.at(-1)
  if (pending === undefined
    || pending['kind'] !== 'tool-call'
    || (pending['mode'] !== 'native' && pending['mode'] !== 'ptc-inner')
    || typeof pending['name'] !== 'string'
    || typeof pending['arguments'] !== 'string') {
    return { reason: 'the last history message is not the pending tool call' }
  }

  let schema: Record<string, unknown> | undefined
  for (const entry of history.slice(0, -1)) {
    if (entry['kind'] === 'tool-schema' && entry['mode'] === pending['mode'] && entry['name'] === pending['name']) {
      schema = entry
    }
  }
  const pendingAction = pendingActionOf({
    ...pending,
    arguments: parseLoggedArguments(pending['arguments'] as string),
    ...(schema === undefined ? {} : { description: schema['description'], parameters: schema['parameters'] }),
  })

  return { sections: { environment, history, pendingAction } }
}

/**
 * Match one stream request against the reviewer's structural fingerprint.
 *
 * Never throws: an unreadable request is `none`, and a request that looked
 * like a review but failed a later element is `suspected`.
 * @param options - the full request the waterfall saw.
 * @returns what the fingerprint observed.
 */
export function matchReviewRequest(options: GenerateOptions): ReviewRequestMatch {
  try {
    const system = options.system
    if (typeof system !== 'string' || !hasPolicyHeader(system)) return { kind: 'none' }

    if (options.temperature !== REVIEW_TEMPERATURE) {
      return { kind: 'suspected', reason: 'temperature is not 0' }
    }
    if (options.sessionId !== undefined) {
      return { kind: 'suspected', reason: 'the request carries a sessionId' }
    }
    if (options.purpose !== undefined) {
      return { kind: 'suspected', reason: 'the request carries a purpose' }
    }

    const messages = options.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return { kind: 'suspected', reason: 'the request has no messages' }
    }

    const texts: string[] = []
    for (const [index, message] of messages.entries()) {
      if (message?.role !== 'user') {
        return { kind: 'suspected', reason: `message ${index + 1} is not a user message` }
      }
      const content = message.content
      if (!Array.isArray(content)) {
        return { kind: 'suspected', reason: `message ${index + 1} has no content blocks` }
      }
      const textBlocks = content.filter(block => block.type === 'text')
      if (textBlocks.length === 0) {
        return { kind: 'suspected', reason: `message ${index + 1} has no text block` }
      }
      texts.push(textBlocks.map(block => block.text).join('\n'))
    }

    if (texts.length === 1) {
      const parsed = parseSections(texts[0]!)
      if ('reason' in parsed) return { kind: 'suspected', reason: parsed.reason }
      return {
        kind: 'match',
        requestText: texts[0]!,
        sections: { protocol: 'sections', policy: system, ...parsed.sections },
      }
    }

    const parsed = parseReviewMessages(texts)
    if ('reason' in parsed) return { kind: 'suspected', reason: parsed.reason }
    return {
      kind: 'match',
      requestText: texts.join('\n\n'),
      sections: { protocol: 'messages', policy: system, ...parsed.sections },
    }
  } catch {
    return { kind: 'none' }
  }
}
