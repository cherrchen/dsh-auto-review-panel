# Troubleshooting

中文：[README.md](./README.md)

## What Belongs Here

Verified problem-solving experience with recurring value. Each entry typically includes:

- Symptoms;
- Root cause;
- Diagnostics;
- Verified solution.

## What Does Not Belong Here

Do not log every one-off error.

Only issues that are expected to recur and are costly to diagnose are worth recording.

## Current State

- [The client bundle never enters the web boot graph: the bundle patch only mounts subpath rows](./client-bundle-not-in-boot-graph.md) — root cause and fix for a silently missing sidebar slot registration.
- [The DSH release is not on the support matrix](./unsupported-dsh-release.md) — the `unsupported` / `mixed` / `incomplete` verdicts, why plugin rows do not start, and the manual promotion flow for a new release.

## Naming Convention

Use lowercase kebab-case, for example:

```text
<symptom-or-topic>.md
```
