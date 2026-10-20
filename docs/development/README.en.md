# Development

中文：[README.md](./README.md)

## What Belongs Here

- Environment setup;
- Development workflow;
- Testing;
- Linting;
- Formatting;
- Build;
- Release;
- Debugging.

## What Does Not Belong Here

- Stable technical reference (goes to `../reference/`);
- Requirements, architecture, or plans.

## Current State

The development environment, toolchain, and verification flow are settled; see:

- [plugin-development-workflow.md](./plugin-development-workflow.md) — build, test, smoke, the runtime support matrix, upstream coupling, and the upgrade flow.
- [release-workflow.md](./release-workflow.md) — the release flow: pre-release preparation (release-state documents and CHANGELOG), the version-bump script, tag conventions, npm publish, and GitHub Release.

## Established Tooling Facts

- Package manager: pnpm (`11.25.0`).
- Language and build: TypeScript (strict, separate host/client faces) + tsdown (per-entry ESM bundle).
- Gates: oxlint, `tsc --noEmit`, vitest, the composition smoke, the pack gate, the documentation check, the compatibility-contract check.

## Documentation Check

Project documentation must satisfy the structural and consistency rules defined in this repository.

The package scripts are already initialized; run:

```bash
pnpm docs:check
```

For the full documentation maintenance rules, see the [`Documentation Skill`](../../.agent/skills/documentation/SKILL.md).

## Naming Convention

Use lowercase kebab-case, for example:

```text
<topic>.md
```
