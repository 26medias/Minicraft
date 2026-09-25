# Player skins — research (2026-09-24)

Goal: replace the coloured-box avatars (`src/engine/render/remote-players.ts`, colours from
`src/data/skins.data.ts`) with real Minecraft-style skins on a Minecraft player rig.
Characters wanted: Milo, Chip, JJ, Mikey, Crazy Fan Girl, plus an Enderman.
**Research record.** This was written before anything was built. The feature is now implemented
to the design in `docs/superpowers/specs/2026-09-24-player-skins-design.md`; the game's copies of
the chosen PNGs live in `src/assets/skins/` (the catalog is `src/data/skins.data.ts`).

The chosen PNGs were collected in `docs/skins/`. `docs/skins/front-sheet.png` is a flat front-view render of
all six, in this order: Milo, Chip, Crazy Fan Girl, JJ, Mikey, Enderman.

## Finding 1 — the characters come from two channels

| Character | Channel | Owner |
|---|---|---|
| Milo, Chip, Alexis ("Crazy Fan Girl") | **Milo & Chip** (Australia, since 2023) | Spawnpoint Media / SPM Brands Pty Ltd |
| JJ, Mikey | **Maizen** (the original JJ & Mikey show) | Maizen (Laser FZCO according to fan wikis, formerly UUUM; not verified) |

- **Chip is modelled on JJ.** The official Milo & Chip skin packs include Milo and Chip dressed as
  JJ and Mikey, which is probably why kids treat the two shows as one universe.
- **Maizen also has a "Crazy Fan Girl"** ("JJ Have A CRAZY FAN GIRL in Minecraft!", 2025-06-30).
  She is a different character: pink hair, cat ears, a maid dress, and a **bloody knife in the
  thumbnail**. ⚠ Don't use that one. The skin chosen here is the Milo & Chip character, Alexis.

## Finding 2 — no official, licensed skin PNGs exist

- **Milo & Chip** sells official skins only as paid Bedrock Marketplace packs (660 Minecoins each):
  "Milo and Chip Friends", "Elemental Milo and Chip" (includes Alexis) and "Milos Family".
  Marketplace content is encrypted, so we can't legally extract PNGs from it. Their website and
  merch store offer no skins.
- **Maizen** has no official skin pack. Their Marketplace item is a map ("Maizencraft – Slime
  Caverns"). The files on `maizen.com/downloads` are 2048² textures for rounded 3D cartoon models,
  not player skins. Skindex's "Official JJ/Mikey skin by @anDREW_22" is a fan upload and the
  "official" claim is unverified. No policy on fan skins was found.
- **There are no license-free skins of these characters.** Every candidate is fan art of a
  trademarked character, and none of the skin pages states a license. Planet Minecraft's footer
  only says "All creations copyright of the creators". No CC0 or public-domain Enderman player
  skin was found either.

⚠ **Same rule as the Mojang block textures (`CLAUDE.md` § Assets): private family use only.** Don't
redistribute these, and don't put them in a public fork. The Enderman skin is also largely Mojang
pixels: 392 of 512 head pixels match vanilla `enderman.png`.

## The chosen skins

All six were downloaded and checked. Dimensions and arm width were measured with PIL. Arm width is
checked with the standard test: slim skins leave x=54–55, y=20–31 transparent.

| File | Character | Size | Arms | Overlay layer | Source | Author | License found |
|---|---|---|---|---|---|---|---|
| `milo.png` | Milo: cyan bird, white belly, yellow beak | 64×64 | **slim** | barely used | [PMC "Milo (New Version)"](https://www.planetminecraft.com/skin/milo-new-version/) | ItzASecret | none; a commenter says the author's rule is "can't modify" |
| `chip.png` | Chip: brown hair, orange shirt and pants, barefoot | 64×64 | **slim** | hair on the hat layer | [Skindex 22621106](https://www.minecraftskins.com/skin/22621106/chip/) | JCMcD | none |
| `crazy-fan-girl.png` | Alexis: long brown hair, pink sweater with a heart, jean shorts | 64×64 | classic | heavy (hair on hat and jacket) | [Skindex 23342088](https://www.minecraftskins.com/skin/23342088/alexis/) | AlexisYTig | none |
| `jj.png` | JJ: red hoodie, white shirt, black pants, pink shoes | 64×64 | classic | hood on the hat layer | [Skindex 20508438](https://www.minecraftskins.com/skin/20508438/jj-maizen/) (pixel-identical to [PMC 5965344](https://www.planetminecraft.com/skin/jj-maizen-5965344/)) | a2022 | none |
| `mikey.png` | Mikey: lime-green turtle, belly plate, red mouth | 64×64 | classic | none | [Skindex 20508444](https://www.minecraftskins.com/skin/20508444/mikey-maizen/) | a2022 | none |
| `enderman.png` | Enderman on a player body: black, purple eyes | **64×32 (legacy)** | classic | none | [PMC "Enderman"](https://www.planetminecraft.com/skin/enderman-4622072/) | KingOD | none; mostly Mojang pixels |

Direct PNG URLs (Skindex): `https://www.minecraftskins.com/uploads/skins/2024/06/19/chip-22621106.png`,
`…/2025/06/17/alexis-23342088.png`, `…/2022/07/01/jj-maizen-20508438.png`,
`…/2022/07/01/mikey-maizen-20508444.png`. Enderman: `https://static.planetminecraft.com/files/resource_media/skin/enderman-e1520.png`.
Planet Minecraft has no direct PNG URL for Milo; the file was taken from the page's 3D viewer data.
Both sites put Cloudflare in front of curl, so the files were fetched with headless Playwright.

**Alternates**
- Milo with classic arms: `docs/skins/alt-milo-classic.png`, from
  [PMC milo-6553011](https://www.planetminecraft.com/skin/milo-6553011/) by PlayzGamer. It looks
  like a conversion of ItzASecret's skin.
- Chip matching the chosen Milo's style: `docs/skins/alt-chip-itzasecret.png`, from
  [PMC chip-new-version](https://www.planetminecraft.com/skin/chip-new-version/) by ItzASecret.
- JJ with slim arms and more shading: [PMC 6448572](https://www.planetminecraft.com/skin/jj-from-maizen-6448572/).
  Mikey with flatter colours: [Tynker](https://www.tynker.com/minecraft/skins/view/mikey-from-maizen/64248a0be253bb1788138003/).
- Enderman: [PMC 1202407](https://www.planetminecraft.com/skin/enderman-1202407/) is closer to
  vanilla, but the underside of its head is see-through.

## What this means for the rig (inputs to the spec)

The skins cover all three variants of the vanilla player format, so the loader has to handle all
three from the start:

1. **Classic 64×64**: 4-px arms. Separate left-limb UVs, plus a second overlay layer (hat, jacket,
   sleeves, trousers).
2. **Slim 64×64 (Alex)**: 3-px arms. Milo and Chip use this. It is a per-skin flag, because it
   can't be reliably read from the pixels (the transparency test above is a heuristic).
3. **Legacy 64×32**: the Enderman. No left-limb UVs (the left arm and leg mirror the right ones)
   and only the hat overlay.

Vanilla geometry, in pixels (16 px = 1 block, whole model scaled by 0.9375 for a player about 1.8
blocks tall):
- head 8×8×8
- body 8×12×4
- arms 4×12×4, or 3×12×4 for slim
- legs 4×12×4

The overlay layer sits on slightly inflated boxes: +0.5 px on the head, +0.25 px elsewhere. Head
yaw and pitch come from the pose we already sync. Arms swing from the shoulder and legs from the
hip, driven by horizontal speed. A mining swing would need an event the protocol doesn't send yet.

Skins need `NearestFilter` and alpha-tested overlays. The texture is 64 px, so each skin is a tiny
texture or a slot in a small skin atlas.

**Protocol:** `skin` is already a string of up to 32 bytes (`docs/multiplayer.md`), so ids like
`milo` and `enderman` fit with no wire change. Colour ids already stored on the server (`red`,
`blue`, …) must keep resolving to something: a default skin, or the current coloured box. The
name-label colour needs a per-skin colour.
