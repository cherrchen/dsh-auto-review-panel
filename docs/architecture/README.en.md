# Architecture

中文：[README.md](./README.md)

## What Belongs Here

- Current Architecture;
- Target Architecture;
- Subsystem design;
- Component boundaries;
- Data flow;
- Interfaces.

## What Does Not Belong Here

- Requirements (goes to `../requirements/`);
- Decision records (goes to `../decisions/`);
- Implementation plans (goes to `../plans/`).

## Important Rule

Do not present Proposals or Target Architecture as facts about the currently implemented system.

Documents describing future designs must clearly state their status.

## Current State

- [`auto-review-panel.md`](./auto-review-panel.md) — Host-side data flow and channel design: capture tee → dual-cap buffer → correlation anchor → `PANEL_CHANNEL`, plus where the facts the client needs for its empty states are produced (current architecture, landed with M1).

## Naming Convention

Use lowercase kebab-case, for example:

```text
<subsystem-or-topic>.md
```
