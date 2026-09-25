import { describe, it, expect } from 'vitest';
import { BLOCKS, BLOCK_BY_NAME } from './blocks.data';
import { PICKAXES } from './crafting.data';
import { CHEATS } from './cheats.data';
import { isCounted } from '../game/inventory';
import { cheatKeys, normalizeCode } from '../game/cheats';

const RICH = [
	'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore', 'iron_ore', 'deepslate_iron_ore',
	'gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
	'lapis_ore', 'deepslate_lapis_ore', 'redstone_ore', 'deepslate_redstone_ore',
];

describe('CHEATS (cheat codes spec §2, §6, §8)', () => {
	it('pins the six rows: codes, aliases, grants and toast texts (catches Big Boom with tunnel/flatten/lake, a missing deepslate or a nether ore, a wrong count, a changed toast)', () => {
		const b = (name: string, count: number) => ({ kind: 'block', name, count });
		expect(CHEATS.map((c) => ({ ...c }))).toEqual([
			{ id: 'big_boom', code: 'Big Boom', also: [], grants: [b('tnt', 50), b('big_tnt', 50), b('mega_tnt', 50)], message: 'Big Boom! +50 TNT, Big TNT and Mega TNT' },
			{ id: 'tunnel_this', code: 'Tunnel this!', also: [], grants: [b('tunnel_tnt', 50)], message: 'Tunnel time! +50 Tunnel TNT' },
			{ id: 'mole_man', code: 'I am Mole Man', also: ["I'm Mole Man"], grants: [{ kind: 'pickaxe', tier: 4 }], message: 'Hello, Mole Man! An Iron Pickaxe for you' },
			{ id: 'mole_power', code: 'Mole Power!', also: [], grants: [{ kind: 'pickaxe', tier: 6 }], message: 'Mole Power! A Diamond Pickaxe for you' },
			{ id: 'jump', code: 'Jump!', also: [], grants: [b('slime_pad', 50), b('launch_pad', 50)], message: 'Boing! +50 Slime Pads and Launch Pads' },
			{ id: 'so_rich', code: 'I am so rich!', also: ["I'm so rich!"], grants: RICH.map((n) => b(n, 500)), message: 'So rich! +500 of every ore' },
		]);
	});

	it('the pickaxe rows are Iron and Diamond by label (catches a tier off by one)', () => {
		const tiers = CHEATS.flatMap((c) => c.grants.flatMap((g) => (g.kind === 'pickaxe' ? [PICKAXES[g.tier].label] : [])));
		expect(tiers).toEqual(['Iron Pickaxe', 'Diamond Pickaxe']);
	});

	it('every granted block exists and is counted (catches a typo such as lapis_lazuli_ore: a silent no-op grant)', () => {
		for (const c of CHEATS) for (const g of c.grants) if (g.kind === 'block') {
			expect(Object.hasOwn(BLOCK_BY_NAME, g.name), g.name).toBe(true);
			expect(isCounted(g.name), g.name).toBe(true);
			expect(Number.isInteger(g.count) && g.count > 0, g.name).toBe(true);
		}
	});

	it('normalised codes and aliases are non-empty and unique across rows (catches a new row shadowing an old one)', () => {
		const all = CHEATS.flatMap(cheatKeys);
		for (const k of all) expect(k).not.toBe('');
		const perRow = CHEATS.map((c) => new Set(cheatKeys(c)));
		const union = perRow.flatMap((s) => [...s]);
		expect(new Set(union).size).toBe(union.length);
	});

	it('no block name or label normalises to a code (catches a future catalog row that turns a block search into a code)', () => {
		const keys = new Set(CHEATS.flatMap(cheatKeys));
		for (const def of BLOCKS.filter(Boolean)) {
			expect(keys.has(normalizeCode(def.name)), def.name).toBe(false);
			expect(keys.has(normalizeCode(def.label)), def.label).toBe(false);
		}
	});
});
