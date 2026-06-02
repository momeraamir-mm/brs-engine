# Engineering Standards — brs-engine (AudioShelf automation fork)

> **Scope.** This document governs changes made to **our fork** of `brs-engine`, which we own and
> are overhauling into a **hardware-independent automation suite** for the `AudioShelf-Roku` channel
> (device-free testing — no physical Roku required). It is additive to the upstream
> [`contributing.md`](./contributing.md): upstream's PR/issue etiquette still applies; the rules
> below are the project-specific bar we hold ourselves to. See also the channel's
> `AudioShelf-Roku/docs/BRIGHTSCRIPT_STDS.md` and `docs/ARCHITECTURE.md`.

---

## 1. Cardinal principle — fidelity over convenience

**The simulator must NEVER be more permissive than a real Roku device.** If the engine accepts
BrightScript that a device rejects, then "green in the simulator" stops meaning "works on the
device," and the whole device-free testing premise collapses.

- When the engine and a real Roku disagree, **the device is the source of truth** — change the engine, not the expectation.
- Match the device's **stage** of failure, not just the fact of it: a device *compile* error must surface at **parse time** in the engine; a *runtime* error at runtime.
- Closing a permissiveness gap is a feature, not a regression — even though it makes previously-"working" code fail.

> **Worked example (2026-06-02).** A real Roku rejects `continue for` / `exit for` outside a
> `for`/`for each` loop (and the `while` equivalents) at compile time (error `&h8d`,
> *"Continue For is not inside a For loop"*). The engine silently accepted it. Fix:
> `src/core/parser/Parser.ts` now tracks an enclosing-loop stack and emits a parse-time `addError`
> for mismatched keywords — matching the device's compile-time behavior. See
> `test/parser/controlFlow/LoopContext.test.js`.

---

## 2. Code conventions

| Rule | Requirement |
|------|-------------|
| Language | TypeScript; bundled via Webpack (see [`build-from-source.md`](./build-from-source.md)) |
| Diffs | **Minimal and additive.** Touch only what the task needs. |
| Patterns | **Match the existing code**, don't invent a parallel one. (e.g. the loop-stack mirrors the existing `functionDeclarationLevel` save/restore-in-`finally` pattern; new compile errors use the existing `addError` mechanism.) |
| Comments | Comment the **why** at every non-obvious block. |
| Formatting | Follow the repo's Prettier config for lines **you** add. **Do not** run `prettier --write` across a whole pre-existing file to "fix" unrelated lines — some upstream files are not Prettier-clean at `HEAD`, and mass-reformatting buries the real change. Verify with `git diff` that your change is what you intend. |
| Pre-existing issues | Distinguish them from your own and say so; don't silently absorb or sweep them into your diff. |

---

## 3. Testing (mandatory for every behavior change)

1. **Add a regression test** following the repo's own conventions:
   - Parser/lexer behavior → a `jest` test under `test/` using `brs.Lexer.scan(...)` + `parser.parse(...)` asserting on `errors`/`statements` (see `test/parser/controlFlow/*.test.js`).
   - Language/runtime behavior → an end-to-end `.brs` resource under `test/e2e/resources/` exercised by the e2e suites.
2. **Cover both directions:** the new rejection/behavior **and** a guard proving valid code is *not* over-rejected. A fidelity fix that breaks legitimate BrightScript is worse than the gap it closed.
3. **Rebuild before trusting results.** The tests import the **built bundle**
   (`packages/node/bin/brs.node`), *not* the TypeScript source. A source-only edit will **not** be
   exercised until you run `npm run build:cli` (or `npm run build`). Always rebuild, then `npm test`.
4. **Know the noisy tests.** Some suites depend on the host environment (e.g.
   `roSocketAddress.brs` / `isAddressValid()` needs working DNS/network) and may fail offline —
   confirm a failure is yours before acting on it.

---

## 4. Where divergences live

- **Compile-time (parser):** `src/core/lexer/`, `src/core/parser/`. Reject here to mirror device compile errors.
- **Runtime (interpreter):** `src/core/interpreter/`. Control-flow signals (`ContinueForReason`, etc.) propagate via throw/catch through the nearest matching loop.
- **Tasks / threading:** the browser/Electron build runs the engine in a worker (SceneGraph **Tasks work**); the headless Node CLI runs the app synchronously on the main thread (**Tasks do not run** — known gap). Prefer the desktop oracle for Task-dependent behavior.
