# Cheat codes (for parents)

Secret codes Noah can type into the search box of the I screen (Blocks tab), then press Enter.
The game never lists them, and a wrong code does nothing at all. Case, spaces and punctuation do
not matter ("molepower" works). A code can be used again any time; each Enter gives the reward
again. Items go into the Blocks grid, never onto the hotbar. They work in multiplayer too.
Only the player who types a code sees its message.

A pickaxe from a code is equipped only if it is better than the one in hand.

The source of truth is `src/data/cheats.data.ts`; `src/data/cheats-docs.test.ts` keeps this
table in step with it, both ways.

| code | also | reward |
|---|---|---|
| Big Boom |  | Big Boom! +50 TNT, Big TNT and Mega TNT |
| Tunnel this! |  | Tunnel time! +50 Tunnel TNT |
| I am Mole Man | I'm Mole Man | Hello, Mole Man! An Iron Pickaxe for you |
| Mole Power! |  | Mole Power! A Diamond Pickaxe for you |
| Jump! |  | Boing! +50 Slime Pads and Launch Pads |
| I am so rich! | I'm so rich! | So rich! +500 of every ore |

The reward column is the toast he sees. In full: Big Boom gives 50 each of TNT, Big TNT and Mega
TNT (not Tunnel, Flattening or Lake TNT); Tunnel this! gives 50 Tunnel TNT; I am Mole Man gives
the Iron Pickaxe (tier 4); Mole Power! gives the Diamond Pickaxe (tier 6); Jump! gives 50 Slime
Pads and 50 Launch Pads; I am so rich! gives 500 of each of the 16 stone and deepslate ores (coal,
copper, iron, gold, diamond, emerald, lapis and redstone), not the nether ores.
