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

No architecture document yet. The design record of the panel surface (the review-state channel and the slot contribution) will land here first; the trade-offs made so far live in `../decisions/` as ADRs.

## Naming Convention

Use lowercase kebab-case, for example:

```text
<subsystem-or-topic>.md
```
