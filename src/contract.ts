/**
 * Wire contract shared by the host and client halves.
 *
 * `PANEL_CHANNEL` names the Connection channel the panel client opens to reach
 * the host-side `auto-review-panel` service. Both halves import it from here so
 * the spelling has exactly one home; the client bundle inlines it at build
 * time.
 *
 * The record model is a READ-ONLY projection of one observed review stream.
 * Every field is either captured verbatim from the review request/response or
 * absent: nothing in this file is derived by re-scoring, guessing, or filling
 * a gap. `requestText` + `sections.policy` reassemble the exact request the
 * reviewer sent, which is what makes the "verbatim" acceptance executable.
 *
 * @module @dsh-electron/dsh-auto-review-panel/contract
 */

/** The Connection channel between the panel client and the host service. */
export const PANEL_CHANNEL = '/auto-review-panel'

/** Risk classes the reviewer protocol can return. */
export type ReviewRisk = 'low' | 'medium' | 'high'

/**
 * The verdict shown for one record.
 *
 * `allow` and `deny` are the reviewer's own protocol decisions. `error` means
 * the response text did not match that protocol; it is never a re-judgement.
 * A reviewer that failed before producing a verdict carries no `decision` at
 * all — its `finish` field says why.
 */
export type ReviewDecision = 'allow' | 'deny' | 'error'

/** How one reviewed call was presented to the model. */
export type ReviewActionMode = 'native' | 'ptc-inner'

/** Terminal failure kinds the reviewer stream can carry. */
export type ReviewFinishKind = 'error' | 'aborted'

/** The decision this plugin's append listener receives from the rest of the waterfall. */
export type DownstreamDecision = 'allow' | 'deny' | 'cancel' | 'ask'

/** Why a reviewer stream ended abnormally. */
export interface ReviewFinish {
  readonly kind: ReviewFinishKind
  /** Provider-neutral failure code from the terminal chunk. */
  readonly code?: string
  /** Human-readable failure message from the terminal chunk. */
  readonly message?: string
}

/**
 * PENDING_ACTION as read from the review request.
 *
 * The known fields are typed only when the JSON value actually carried them;
 * anything unreadable is absent rather than defaulted. Unknown extra fields
 * survive under the index signature, because the record is an audit artifact.
 */
export interface ReviewPendingAction {
  readonly mode?: ReviewActionMode
  readonly name?: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
  readonly arguments?: unknown
  readonly [key: string]: unknown
}

/**
 * The five request sections.
 *
 * `policy` is `options.system` verbatim; the four data sections are the parsed
 * JSON values from the user message. `requestText` keeps the user message
 * verbatim for audit and exact comparison.
 */
export interface ReviewSections {
  readonly policy: string
  readonly environment: unknown
  readonly projectInstructions: unknown
  readonly filteredHistory: unknown
  readonly pendingAction: ReviewPendingAction
}

/** The error identity a downstream `deny` decision carried back through the waterfall. */
export interface ReviewDenialInfo {
  readonly name: string
  readonly code: string
}

/**
 * What the `tools/pre-execute` correlation anchor observed.
 *
 * `downstreamDecision` is the decision this plugin's listener received from
 * the rest of the waterfall — not the reviewer's decision. With this plugin's
 * listener prepended ahead of the reviewer's (the composition order the
 * bundle's patch produces), that rest includes the reviewer itself, so
 * `deny + never` verdicts arrive here as `deny` carrying
 * `denialInfo: {name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED'}`,
 * and the reviewer's converted `ask` arrives as `ask`. When the composition
 * mounts the reviewer first, this listener only sees executions whose
 * waterfall reached it — `deny + never` then leaves the record uncorrelated.
 * `denialInfo` is the verbatim `info` a downstream `deny` carried, never
 * re-derived.
 */
export interface ReviewCorrelation {
  readonly sessionId: string
  readonly callId: string
  readonly downstreamDecision: DownstreamDecision
  readonly denialInfo?: ReviewDenialInfo
}

/**
 * How the host disposed of one correlated call, read verbatim from Session
 * events. Evidence attaches only to records with `correlation.callId` — an
 * uncorrelated record never carries this field.
 */
export interface ReviewHostOutcome {
  /**
   * The `tool/result` event logged for this call. `isError` outcomes carry
   * the logged error identity — `AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`
   * for a reviewer denial.
   */
  readonly toolResult?: {
    readonly isError: boolean
    readonly name?: string
    readonly code?: string
    readonly reason?: string
  }
  /**
   * The `approval/asked` + `approval/decided` audit pair logged for this
   * call — the human approval surface an upstream `ask` routed through.
   * `outcome` is the `approval/decided` value; absent while the ask is open.
   */
  readonly approval?: {
    readonly outcome?: string
  }
}

/** The reviewer's response, with the raw final text always retained. */
export interface ReviewOutput {
  readonly risk?: ReviewRisk
  readonly decision?: ReviewDecision
  readonly reason?: string
  /** The final text block verbatim; the source of truth for "model output". */
  readonly rawText: string
}

/** One captured review. Frozen as soon as it enters the host buffer. */
export interface ReviewRecord {
  readonly id: string
  readonly capturedAt: string
  readonly provider: string
  readonly model: string
  readonly requestText: string
  readonly sections: ReviewSections
  readonly reasoning: readonly string[]
  readonly output: ReviewOutput
  readonly finish?: ReviewFinish
  readonly correlation?: ReviewCorrelation
  readonly hostOutcome?: ReviewHostOutcome
}

/** The compact row the list endpoint returns. */
export interface ReviewRecordSummary {
  readonly id: string
  readonly capturedAt: string
  readonly action: {
    readonly name?: string
    readonly mode?: ReviewActionMode
    /**
     * One-line preview of the pending action's most identifying argument —
     * the command for exec-style calls, the path for file calls. Projected
     * host-side from `pendingAction.arguments`, truncated; absent when the
     * arguments carry no string member worth showing.
     */
    readonly preview?: string
  }
  readonly risk?: ReviewRisk
  readonly decision?: ReviewDecision
  /** `output.reason`, truncated for the list row. */
  readonly reason?: string
  readonly finish?: ReviewFinish
  readonly correlated: boolean
}

/** Host-reported facts the client needs to choose its empty state. */
export interface PanelStatus {
  /** Whether the Auto preset is currently advertised by `permissionPresets`. */
  readonly reviewerAvailable: boolean
  /** The session's current preset, when the session is known and readable. */
  readonly sessionPreset?: string
  /**
   * The loader entry name of the mounted reviewer bundle (e.g.
   * `@deepseek-ai/dsh-experimental-auto-review`), when the composition lets
   * the host read it back.
   */
  readonly reviewerPackage?: string
  /**
   * The tool names the session's agent can see in the live registry, sorted.
   * Read from the registry, never inferred from captured records; the reserved
   * `run_code` transport is excluded because the reviewer never reviews the
   * transport itself. Absent when the host cannot read the registry.
   */
  readonly tools?: readonly string[]
}

/** `list` success value. Records are newest first. */
export interface PanelListValue {
  readonly records: readonly ReviewRecordSummary[]
  readonly status: PanelStatus
  /**
   * Keyset pagination over the merged memory + persisted history: `hasMore`
   * says strictly older entries exist, and `before` is the cursor that fetches
   * the next page (the `capturedAt|id` of the last row returned).
   */
  readonly page: {
    readonly hasMore: boolean
    readonly before?: string
  }
}

/** `list` request payload. */
export interface PanelListRequest {
  readonly sessionId?: string
  /** Return only entries strictly older than this `capturedAt|id` cursor. */
  readonly before?: string
  /** Maximum rows; absent uses the host default. */
  readonly limit?: number
}

/** `get` request payload. */
export interface PanelGetRequest {
  readonly id: string
  /** The session the record is expected under; persisted lookups need it. */
  readonly sessionId?: string
}

/**
 * Retention limits for the persisted history, configured from the row's
 * `plugins.row.config` page. `0` on any axis means unlimited — the shipped
 * default keeps everything.
 */
export interface ReviewHistoryRetention {
  /** Newest records kept per session file; older ones are compacted away. */
  readonly maxRecordsPerSession: number
  /** Session files kept; the oldest by mtime are removed past the cap. */
  readonly maxSessions: number
  /** Total size cap across session files plus the unassigned log. */
  readonly maxTotalMegabytes: number
}

/** The shipped retention: keep everything. */
export const DEFAULT_RETENTION: ReviewHistoryRetention = {
  maxRecordsPerSession: 0,
  maxSessions: 0,
  maxTotalMegabytes: 0,
}

/** `stats` success value: the persistence store's health report. */
export interface PanelStatsValue {
  /** Whether the history root is usable; `false` means memory-only mode. */
  readonly available: boolean
  /** Symbolic location (`~/.dsh/…` or `$DSH_HOME/…`), never a machine path. */
  readonly location?: string
  readonly settings: ReviewHistoryRetention
  /** Session log files currently kept. */
  readonly sessions: number
  /** Total bytes of session files plus the unassigned log. */
  readonly bytes: number
  /** The last persistence failure the store swallowed, when one exists. */
  readonly lastError?: string
}

/** `update-settings` request payload. */
export interface PanelUpdateSettingsRequest {
  readonly retention: ReviewHistoryRetention
}

/** What one retention-triggered maintenance pass did. */
export interface PanelMaintenance {
  /** Session files rewritten down to their per-session cap. */
  readonly compactedSessions: number
  /** Session files removed by the session-count or total-size caps. */
  readonly removedSessions: number
  /** Records dropped by compaction or eviction. */
  readonly removedRecords: number
  /** Conditions the pass could not fully honor (e.g. an individually oversized file). */
  readonly warnings?: readonly string[]
}

/** `update-settings` success value: post-write stats plus what maintain() did. */
export interface PanelUpdateSettingsValue {
  readonly stats: PanelStatsValue
  readonly maintenance: PanelMaintenance
}

/** `clear` request payload; `confirm` must be exactly `true`. */
export interface PanelClearRequest {
  readonly confirm: true
}

/** `clear` success value: what was removed, then the emptied stats. */
export interface PanelClearValue {
  readonly removedSessions: number
  readonly removedBytes: number
  readonly stats: PanelStatsValue
}

/** One carrier-neutral failure returned by a panel endpoint. */
export interface PanelRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** One carrier-neutral endpoint result. */
export type PanelRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PanelRpcFailure }
