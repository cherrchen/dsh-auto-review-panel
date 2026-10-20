# Project Documentation

This directory holds the project's long-term documentation and engineering knowledge.

中文：[README.md](./README.md)

## Documentation Map

| Directory | Purpose |
| --- | --- |
| [`requirements/`](./requirements/README.md) | Product, functional, and non-functional requirements |
| [`architecture/`](./architecture/README.md) | Current architecture, target architecture, and system design |
| [`decisions/`](./decisions/README.md) | Architecture Decision Records |
| [`plans/`](./plans/README.md) | Active and completed implementation plans |
| [`development/`](./development/README.md) | Development workflow and engineering practices |
| [`guide/`](./guide/README.md) | User guide: the operational detail the top-level README omits |
| [`reference/`](./reference/README.md) | Stable technical reference |
| [`troubleshooting/`](./troubleshooting/README.md) | Known issues, diagnostics, and solutions |

## Current Documents

The project currently focuses on the DSH Auto Review Panel plugin under one hard constraint: **no package in the upstream repository (deepseek-harness) may be modified** — all deliverables are an external plugin/bundle installed via `dsh plugin add` or profile patch composition. The core documents are:

| Document | Location |
| --- | --- |
| Requirements | [`requirements/auto-review-panel.md`](./requirements/auto-review-panel.md) |
| Development path and progress ledger (plan) | [`plans/completed/2026-10-20-auto-review-panel.md`](./plans/completed/2026-10-20-auto-review-panel.md) |
| Upstream Auto Review survey (reference) | [`reference/upstream-auto-review.md`](./reference/upstream-auto-review.md) |
| Compatibility code contract (ADR-0001) | [`decisions/ADR-0001-dsh-compat-contract.md`](./decisions/ADR-0001-dsh-compat-contract.md) |
| Upstream coupling policy (ADR-0002) | [`decisions/ADR-0002-upstream-coupling-policy.md`](./decisions/ADR-0002-upstream-coupling-policy.md) |
| Review-record capture seam (ADR-0003) | [`decisions/ADR-0003-review-record-capture.md`](./decisions/ADR-0003-review-record-capture.md) |

## Core Principles

### Single Source of Truth

Do not maintain the same project fact independently in multiple documents.

Prefer linking to the canonical source instead of copying its contents.

### Separate Current Facts from Future Design

The current, actually implemented state of the system must be clearly distinguished from proposals, target designs, and future plans.

### Documentation Evolves with Code

When an implementation change invalidates documented facts, update the documentation in the same change.

### Record Important Decisions

Important architecture and engineering decisions should be progressively recorded in `decisions/`.

### Preserve Development Plans

Large development tasks should later start with a plan in `plans/active/`.

Once a task is completed, move the plan to `plans/completed/` instead of deleting it.

## Language

Chinese is the primary documentation language.

Every README is maintained in two versions:

- `README.md`
- `README.en.md`

`README.md` is the canonical Chinese version. When updating either version, check whether the other needs to be synchronized; in case of conflict, the Chinese version prevails.
