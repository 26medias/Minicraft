# Sound

Sound effects, ambient loops and background music. The files were generated with ElevenLabs
and picked by ear on 2026-09-26; `src/assets/sounds/SOURCES.md` records each one's prompt.
Status: **built, rev 2** (after the engine and kid-lens reviews; Audio screen added) (branch `sound`).

## 1. What the player hears

| Moment | Sound | Rule |
|---|---|---|
| Digging a block | `sfx/hit_<material>` | First hit when the mine starts, then one every 250 ms until it breaks or is cancelled; none within 100 ms of the break; blocks that break in under 300 ms play no hits. |
| The block breaks | `sfx/break_<material>` | Once per break. An area break (big pickaxe) plays one break sound for the aimed block's material, not one per block. |
| The block goes into the inventory | `sfx/pickup` | 60 ms after the break sound, at most once every 500 ms (area breaks and TNT included: `onBlocksRemoved` fires only when something was removed, and every removed block is added). |
| Placing a block | `sfx/place_hard` (stone, glass materials) or `sfx/place_soft` (everything else) | Once per successful place or shift-replace. The existing refused-place `playNope` stays. |
| Falling or jumping into water | `sfx/splash` | The feet enter water after at least 1 s out of it, falling faster than 5 blocks/s (so swimming and hopping at the surface never splashes). |
| TNT (all kinds) | `sfx/tnt` | At detonation, attenuated by distance (full next to it, silent from 64 blocks). A chain plays a boom at most every 250 ms and at most 3 at once. Fireworks keep their own effect; no boom. |
| Near still water | `ambient/lake` | Loop; volume from the scan (§5). |
| Near flowing water | `ambient/stream` | Loop; volume from the scan. |
| Near a waterfall | `ambient/waterfall` | Loop; volume from the scan. |
| High up, under the open sky | `ambient/wind_light`, `ambient/wind_strong` | Loops; volume from altitude (§6). |
| Background | `music/*` | One track at a time with long silences (§7). |
| Crafting, refused place | `playCraft`, `playNope` (synthesized, in `src/ui/sfx.ts`) | Unchanged, but routed through the sound-effects volume. |

## 2. Materials as data

`BlockDef` gets an optional `sound?: BlockSound` where
`BlockSound = 'stone' | 'dirt' | 'wood' | 'sand' | 'leaves' | 'glass'`. A row's own `sound` wins;
otherwise `SOUND_RULES` in `src/audio/block-sounds.ts` resolves it from the name's `_` tokens
(whole tokens, not substrings, so `sandstone` is stone and not sand), in order, else `stone`. No
catalog row changes and no regeneration: a new block is heard correctly as soon as its name is.
A vitest checks every live block resolves and spot-checks the names a player would notice
(sandstone, mud bricks, pumpkin, jack o'lantern, concrete powder, stained glass).

## 3. Engine

New folder `src/audio/`:

- `engine.ts` — one `AudioContext` (the one `sfx.ts` already creates lazily moves here), created
  and resumed on the first click or key. Three gain buses to a master: **sounds** (effects), **ambient**
  and **music**. Effects and ambient loops are decoded into `AudioBuffer`s once, on the first
  gesture after entering a world (about 0.6 MB of mp3). A sound asked for before its buffer is
  ready is dropped, not queued.
- `sounds.data.ts` — the file table (`import.meta.glob(..., { query: '?url' })`), each with a
  base volume that evens out the files' own loudness (measured with ffmpeg ebur128; the files
  differ by up to 20 dB), and a levelling gain per music track. A limiter on the master output
  (−10 dB, ratio 12) keeps stacked sounds from distorting.
- Each one-shot gets a ±6% random playback rate so repeated hits don't sound like a machine gun.
- Looped buffers: the files decode to exactly 12.000 s (gapless headers), but `wind_strong` clicks
  where it wraps. At load every loop's last 10 ms are crossfaded into its first 10 ms and the loop
  restarts at 10 ms, which makes the wrap continuous.
- **Tab hidden** → `ctx.suspend()`; visible again → `resume()`. rAF already stops, and a loop
  droning in a background tab is wrong.
- **Pause menu or inventory open** → sounds and ambient keep playing at 50% (world is frozen, it
  should still feel like the world). Music unchanged.
- **Quit to the main menu** → everything fades out over 0.5 s, and the music stops.

## 4. Where sounds come from

The local player's sounds play at full volume, not positioned. Other sounds are attenuated by
distance `d` from the listener's eye: `gain = clamp(1 − d / 32, 0, 1)²`. No stereo panning
(keeps it simple; the kid plays with laptop speakers).

Other players (multiplayer): only an `edit` that `isHandEdit` accepts (≤ 9 ops, no liquids, checked
before it is applied) makes a sound: one per message, the nearest cell's break or place sound, at
most one every 150 ms. Blasts and water flow never do. Edits in the first 3 s of a world are the
world catching up and stay silent. Remote mining plays a hit at the existing puff (every 450 ms).
TNT seen by `onFx 'boom'` plays `tnt` attenuated. All attenuated by distance.

## 5. Water ambience scan

Every 250 ms (not every frame), sample the loaded chunks around the eye. Reads go through
`world.getChunk` + `chunk.get`, never `world.getBlock` (which generates chunks).

- Box: 12 blocks each way horizontally, 8 down and 8 up from the eye; stride 1 (≈ 10 000 reads per
  scan, 40 000 per second).
- Each water cell at distance `d` has weight `w = (1 − d / 13)²` (0 beyond 13).
  - **Waterfall**: a flow cell (`chunk.isFlow`) with water directly above it and air on at least
    one side (a falling column seen from outside; a pond's walls do not count).
  - **Stream**: any other flow cell.
  - **Lake**: a source cell with air directly above it (the surface; deep water does not count).
- Level for a class = `min(1, max(nearest weight, Σ weights / 20))`: one cell a block away reads
  clearly, a big lake is louder than a puddle, and the level falls smoothly walking away (the
  review measured the first rule stuck at full volume from 1 to 8 blocks from a shore).
- **Generated worlds hold only still (source) water, rivers included**, like Minecraft. So the
  stream and waterfall sounds play only near water the player pours; a poured pond is all flow
  cells and sounds like a stream while it exists.
- Loop gains follow the levels with a 0.4 s time constant (`setTargetAtTime`), so walking feels smooth.
- When the eye is underwater (`player.swimming`), all water ambience drops to 30% and wind to 0.

## 6. Wind

Only when the eye is under the open sky: sky light at the eye cell is 15 (`chunk.getSky`).
Indoors or in a cave, both wind loops fade to 0.

Height above the sea `h = eyeY − sea`, where sea is 28 for gen v1 and 120 for v2/v3.
With `span = world.height − sea` (136 on v2/v3):

- `light = ramp(h, 0.12·span, 0.35·span) × (1 − 0.6·strong)` — about 16 → 48 blocks above sea on v3.
- `strong = ramp(h, 0.30·span, 0.75·span)` — about 41 → 102 blocks above sea on v3.
- `ramp(x, a, b) = clamp((x − a)/(b − a), 0, 1)`, smoothed with a 1 s time constant.

The fractions are to be checked against the real v3 terrain: a normal hill should have a light
breeze, a mountain top and flying high should be windy, and walking on a beach should be silent.

## 7. Music

Four tracks: morning_piano, building_time, over_the_mountains, forest_clearing (80 s each).

- Played through an `<audio>` element per track (streamed, not decoded into memory), connected
  into the music bus with `createMediaElementSource`.
- First track 20–60 s after entering a world. After a track ends: silence of 2–5 minutes, then
  the next. Shuffled; never the same track twice in a row. Fade in over 2 s.
- Continues through the pause menu. Stops on quit to the main menu.
- The scheduler is a pure function of an rng and times (`nextTrack(prev, rng)`, `nextGap(rng)`),
  so it is tested without audio.

## 8. The Audio screen

A new **Audio** screen (Julien's ask), reachable from two places:

- the Esc pause menu: an **Audio** button under Controls, opening an Audio view in the same card
  the way Controls does, with Back to the card;
- the main menu: a small **Audio** button next to Options, opening the same controls in a menu
  card.

It has three sliders, 0–100, applied live while dragging:

| Slider | Controls | Default |
|---|---|---|
| **Music** | the music bus | 50 |
| **Sound effects** | mining, placing, pickup, splash, TNT, crafting, refused place | 80 |
| **Nature** | water and wind loops (the ambient bus) | 80 |

Releasing the Sound effects slider plays one `place_soft` at the new level, so it can be judged.
Nature and Music are heard live in-game; from the main menu there is nothing to hear, which is fine.

Saved under their own key `minicraft:v1:audio` as `{ music, sfx, ambient }` (integers 0–100), not in
`Options`: `main.ts` keeps an Options copy from world start and saves it back when a light's colour
changes, which would put old volumes back. A missing or bad value falls back to its default.
A slider value becomes gain as (value/100)², so the low half of the slider is usable.
0 means silent, and music at 0 does not start tracks at all. The screen is not behind the parent
PIN: it is volume, which a kid may fairly turn down.

The UI is built as one small `AudioPanel` (DOM only, like `PauseMenu`) used by both menus, so the
two places cannot drift apart.

## 9. Tests

- **vitest (node)**: material rules (every live block resolved; spot checks); the water scan on a
  fake chunk sampler (lake surface, deep water not counted, a waterfall column, a stream, distance
  falloff, nothing past 13); the wind curve (beach 0, hilltop light only, summit strong, cave 0);
  the music scheduler (first delay in range, gaps in range, never repeats); options load old
  saves (and bad values) with the three volume defaults.
- **Browser smoke** `npm run smoke:sound` (`scripts/sound-smoke.ts`; headless Chromium with autoplay
  allowed, its own dev server on port 5199, every non-localhost request aborts the run). It first
  requires the AudioContext to be running and the files decoded. Then: a real Shift+right-click
  replaces stone with planks (exactly `place_soft`); mining a stone block with the hand logs one
  hit per 250 ms (± 1), one `break_stone` after them, then `pickup`; over a 12×12 pool the lake
  level is > 0.5; at y 235 the lake is 0 and strong wind > 0.8; inside rock the wind is 0; Esc →
  Audio shows three sliders and Music 0 is saved; the main menu's Audio shows it.
  Checked red on two mutants (no place sound; hits every 50 ms).
