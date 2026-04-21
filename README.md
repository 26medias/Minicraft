# Minicraft

A stripped-down, kid-friendly Minecraft clone for the browser. Built for Noah (7yo) who loves Minecraft but doesn't need the mobs, multiplayer, or menus — just mining and building.

## Goals

- **Minimal scope.** Mining and building. Nothing else.
- **No enemies, no multiplayer, no survival pressure.** Pure creative play.
- **Runs as a static web app.** Deployable to a GCP bucket, served through Cloudflare on a subdomain.
- **Easy to extend.** Clean architecture so new blocks, recipes, or features can be added without rework.

## Features

### Gameplay
- Start a new game from a seed (deterministic world generation).
- Mine and place blocks, Minecraft-style.
- Basic crafting recipes — no crafting table, recipes resolve directly from the inventory.
- Keyboard arrows for movement; mouse for looking around and interacting.

### Persistence
- **Phase 1:** Save/load to `localStorage`.
- **Phase 2:** Save/load via a remote API (schema designed so the swap is local-only).

### Options
- **Block set:** all blocks, or a curated "basic" subset (kid mode).
- **Keybindings:** remappable controls for the basic actions.

## Non-Goals

Explicitly out of scope so the project stays small:
- Mobs, combat, health, hunger
- Multiplayer / networking gameplay
- Day/night cycle mechanics that affect gameplay
- Redstone, command blocks, advanced automation
- Mod loading, resource packs beyond the bundled textures

## Tech Stack (planned)

- **Rendering:** WebGL (likely via Three.js) — voxel chunks.
- **Language:** TypeScript.
- **Build:** Vite → static bundle.
- **Hosting:** GCP Cloud Storage bucket, fronted by Cloudflare.

## Assets

Block textures live in `src/assets/blocks/` — extracted from a local Minecraft 1.21.6 install (1,083 PNGs). These are Mojang's assets; the project is for personal/family use only and is not intended for redistribution.

## Project Status

Early scaffolding. Run `/init` next to generate the canonical `CLAUDE.md`.
