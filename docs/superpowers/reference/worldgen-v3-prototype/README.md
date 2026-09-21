# Worldgen v3 prototype (reference only)

Throwaway Node/tsx prototype that produced the evidence in
`docs/superpowers/specs/2026-09-21-worldgen-v3-design.md` §12 and passed the
three gate-1 rounds. It is NOT game code and is not imported by `src/`.

- `proto.ts` — the generator rules exactly as the spec states them (the
  spec is the contract; where they differ, fix the spec or the port, never
  this file silently).
- `check.ts` — sharded map checker for §11 (exact counters + statistical
  bounds; `MUT=<name>` env builds the named mutants).
- `kid.ts` — 100-seed spawn/kid-distance harness (§11.11–11.12).
- `ravines.ts`, `timing_cold.ts`, `merge.ts` — evidence helpers.
- `hash.ts` — spec §10 bootstrap: prints the four FNV-1a-32 reference hashes for the engine and the prototype (ids remapped) and `AGREE`/`DISAGREE`.

Reference hashes recorded 2026-09-21: see spec §10.

Run from the repo root with `./node_modules/.bin/tsx docs/superpowers/reference/worldgen-v3-prototype/check.ts 1,2,3`.
Harness-only `Math.hypot/sin/cos` in `kid.ts` are measurement code, not generation.
