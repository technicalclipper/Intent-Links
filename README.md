# IntentLink

**Don't send instructions. Send the intent.**

A creator demonstrates a task once in any web app. IntentLink turns the
demonstration into a portable, parameterized workflow, the creator attaches
boundaries in plain English, and the result is a shareable link. The receiver
runs it with their own browser, their own sessions, their own credentials —
while a deterministic policy engine gates every action before it happens.

The core innovation is not recording clicks. It is transferring **executable
intent while preserving bounded authority** across environments.

## Two architectural commitments

**1. Capture is coordinate-free.** Every element is described by its
accessibility properties — role, accessible name, section, landmark — never by
coordinates, CSS selectors or DOM paths. This is why the recorder needs zero
per-app integration and why a workflow recorded in one UI survives a redesign,
a different tenant, or a different locale. The `ElementDescriptor` schema is
`.strict()` and a test asserts that no geometry field can enter it.

**2. The extension is the only client; the server is the only authority.** The
agent proposes a semantic action; the policy engine decides, server-side,
against a policy hash pinned at execution start; a signed single-use token
bound to the resolved target comes back; the extension spends it on exactly one
action. The model can propose anything. It cannot authorize anything.

## Packages

| Package | Role |
|---|---|
| `packages/schema` | The four frozen schemas: descriptor, trace, IntentLink, policy. Everything integrates against these. |
| `packages/a11y` | `describe(el)` — the shared core. The recorder calls it on what the creator touched; the executor calls it on every candidate it resolves against. One function, two directions. |

## Status

- [x] Monorepo scaffold, TS project references
- [x] **Descriptor / trace / IntentLink / policy schemas** — frozen, with fixtures
- [x] **a11y serializer** — role resolution, accessible-name computation, section/landmark/ordinal
- [ ] Policy engine + validator + token issuer + audit chain
- [ ] Extension: capture
- [ ] Extension: resolution ladder + execution
- [ ] Gemini: intent compiler, grounded policy compiler, resolution assist
- [ ] Web surfaces: creator, consent, timeline, block screen, audit, library

## Develop

```bash
npm install
npm run build
npm test
```
