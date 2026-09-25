import type { PickaxeTier } from './crafting.data';

/**
 * Cheat codes (spec 2026-09-25-cheat-codes-design). Easter eggs: the UI never lists them;
 * docs/cheats.md does, for the parent. Adding a code is adding a row.
 */
export type CheatGrant =
	| { kind: 'block'; name: string; count: number }
	| { kind: 'pickaxe'; tier: PickaxeTier };
/** `code` is what Julien tells Noah; `also` lists other accepted spellings. All match through normalizeCode. */
export type Cheat = { id: string; code: string; also: string[]; grants: CheatGrant[]; message: string };

const ORES = ['coal', 'copper', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'redstone'];
const block = (name: string, count: number): CheatGrant => ({ kind: 'block', name, count });

export const CHEATS: readonly Cheat[] = Object.freeze([
	{ id: 'big_boom', code: 'Big Boom', also: [], grants: [block('tnt', 50), block('big_tnt', 50), block('mega_tnt', 50)], message: 'Big Boom! +50 TNT, Big TNT and Mega TNT' },
	{ id: 'tunnel_this', code: 'Tunnel this!', also: [], grants: [block('tunnel_tnt', 50)], message: 'Tunnel time! +50 Tunnel TNT' },
	{ id: 'mole_man', code: 'I am Mole Man', also: ["I'm Mole Man"], grants: [{ kind: 'pickaxe', tier: 4 }], message: 'Hello, Mole Man! An Iron Pickaxe for you' },
	{ id: 'mole_power', code: 'Mole Power!', also: [], grants: [{ kind: 'pickaxe', tier: 6 }], message: 'Mole Power! A Diamond Pickaxe for you' },
	{ id: 'jump', code: 'Jump!', also: [], grants: [block('slime_pad', 50), block('launch_pad', 50)], message: 'Boing! +50 Slime Pads and Launch Pads' },
	{ id: 'so_rich', code: 'I am so rich!', also: ["I'm so rich!"], grants: ORES.flatMap((o) => [block(`${o}_ore`, 500), block(`deepslate_${o}_ore`, 500)]), message: 'So rich! +500 of every ore' },
]);
