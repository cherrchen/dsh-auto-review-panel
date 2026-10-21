# Plans

中文：[README.md](./README.md)

## What Belongs Here

Implementation plans for large development tasks, such as:

- Features;
- Refactors;
- Migrations;
- Architectural changes.

## Directory Layout

```text
active/     plans that are in progress or not yet started
completed/  completed plans
```

When a task is finished, move its plan from `active/` to `completed/`:

```text
active/
→
completed/
```

Plans with long-term reference value should not be deleted.

## What Does Not Belong Here

- Scratch TODOs for small tasks;
- Abandoned drafts with no reference value (just delete those);
- Formal design documents (goes to `../architecture/`, or use `../../.agent/templates/design.md`).

## Current State

active:

- (none)

completed:

- [2026-10-20-auto-review-panel.md](./completed/2026-10-20-auto-review-panel.md) — the Auto Review Panel development path and **progress ledger**: initialization, M1 review-record capture, M2 panel, M3 polish & first release, and M4 persistence — all complete, shipping with `v0.1.0`.
- [2026-10-21-m4-review-record-persistence.md](./completed/2026-10-21-m4-review-record-persistence.md) — M4: per-session review-record persistence (per-session JSONL + retention settings page + pagination), complete, shipping with `v0.1.0`.

### Numbering

- **M1 onward** are roadmap milestones; initialization has no milestone number.
- Single source of truth: the roadmap's [progress ledger](./completed/2026-10-20-auto-review-panel.md#进度总账).

## Naming Convention

Use lowercase kebab-case, for example:

```text
YYYY-MM-DD-<short-title>.md
```

See the `.agent/templates/plan.md` template.
