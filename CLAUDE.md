# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Vision

Minicraft is a **deliberately minimal** Minecraft-style voxel sandbox for a 7-year-old. The whole point is what it *doesn't* do. Before adding anything, check it against the non-goals below.

**Core loop:** mine blocks, place blocks. That's it.

**Hard non-goals** (do not add, do not suggest adding unless asked):
- Mobs, combat, health, hunger, damage
- Multiplayer, networking gameplay, accounts
- Survival mechanics (day/night gameplay, weather effects, hunger)
- Redstone, command blocks, automation, farming
- Mod loading, custom resource packs
- Achievements, quests, progression systems

When in doubt about scope, lean toward removing features, not adding them. See `README.md` for the full feature list and target UX.

## Repo State

The project is **implemented and deployed**. TypeScript + Vite + Three.js, with
vitest for tests. `npm run dev` serves it at `localhost:5173`; the built bundle
is hosted at `https://noah.leap-forward.ca/minicraft/`.

Layout: `src/engine/` (world, render, input), `src/game/` (loop, player,
liquids, TNT), `src/ui/`, `src/persistence/`, `src/data/` (`*.data.ts` are pure
data). `api/` holds the Cloud Function for cloud saves and deploys separately.

Per-subsystem docs live in `docs/`: `lighting.md`, `liquids.md`, `movement.md`,
`persistence.md`. `docs/specs.md` is the source of truth for the tech stack.

⚠ **The kid's real worlds live in the localStorage of
`https://noah.leap-forward.ca` and in `gs://minicraft-worlds`. Never point tests
at the production site.** Test at `localhost:5173`. `./deploy.sh` deploys the API
only — the website is deployed by hand.

## Assets

Block textures in `src/assets/blocks/` are Mojang's, extracted from the user's own Minecraft install for personal/family use. Do not redistribute, do not commit them to a public fork, and do not treat them as open-source assets. If the project later gains a public face, these need to be replaced with original or properly licensed art.

The extraction source was `~/.minecraft/versions/1.21.6/1.21.6.jar` under `assets/minecraft/textures/block/`. `.mcmeta` animation files were intentionally skipped.

## Extensibility Expectations

The README commits to "easy to extend." In practice this means new work should:
- Treat the block catalog as data, not hardcoded enums — adding a block should be adding a row, not editing ten files.
- Keep crafting recipes as data too (no crafting table UI; recipes resolve from inventory).
- Keep persistence behind a narrow interface so the Phase 1 (`localStorage`) → Phase 2 (remote API) swap is local.
- Keep the "basic blocks" vs "all blocks" kid-mode toggle as a filter over the same catalog, not a parallel set.

## Deployment Target

Final artifact is a **static bundle** hosted in a GCP Cloud Storage bucket behind Cloudflare. No server-side runtime in Phase 1. Keep this in mind when picking libraries or designing persistence — anything that requires a backend is Phase 2.
