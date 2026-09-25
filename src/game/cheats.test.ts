import { describe, it, expect, vi } from 'vitest';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { CHEATS } from '../data/cheats.data';
import { canPlace } from './inventory';
import { applyCheat, matchCheat, normalizeCode } from './cheats';

const id = (text: string) => matchCheat(text)?.id ?? null;

describe('normalizeCode / matchCheat (spec §4)', () => {
	it('ignores case, punctuation and every space (catches a case-sensitive rule, kept punctuation, or only collapsed spaces)', () => {
		for (const s of ['mole power', 'MOLE POWER!!', '  Mole   Power ', 'mole-power', 'molepower']) expect(id(s), s).toBe('mole_power');
	});
	it('matches the aliases and folds accents and fullwidth letters (catches aliases ignored, or no NFKD fold)', () => {
		for (const s of ["I'm so rich!", 'i m so rich', 'I am so rích']) expect(id(s), s).toBe('so_rich');
		expect(id("I'm Mole Man")).toBe('mole_man');
		expect(id('ＪＵＭＰ')).toBe('jump');
	});
	it('is a whole-string match, and blank text matches nothing (catches a substring or prefix rule)', () => {
		for (const s of ['mole powers', 'mole', '', '   ', '!!!', 'diamond', 'tnt', 'big boom please']) expect(id(s), s).toBe(null);
	});
	it('normalizeCode keeps only a-z and 0-9', () => {
		expect(normalizeCode('Tunnel this!')).toBe('tunnelthis');
		expect(normalizeCode('Ünder 9')).toBe('under9');
	});
});

const cheat = (cid: string) => CHEATS.find((c) => c.id === cid)!;
type P = { inventory: Inventory; tools: PlayerTools; hotbar: number[] };
const player = (inventory: Inventory = {}, tools: PlayerTools = { owned: [0], equipped: 0 }): P => ({ inventory, tools, hotbar: [1, 2, 3] });

describe('applyCheat (spec §7)', () => {
	it('adds, never sets: a repeat stacks (catches an idempotent grant or an assignment)', () => {
		const p = player();
		applyCheat(p, cheat('big_boom'), () => {});
		expect([p.inventory.tnt, p.inventory.big_tnt, p.inventory.mega_tnt]).toEqual([50, 50, 50]);
		applyCheat(p, cheat('big_boom'), () => {});
		expect([p.inventory.tnt, p.inventory.big_tnt, p.inventory.mega_tnt]).toEqual([100, 100, 100]);
		const q = player({ big_tnt: 7 });
		applyCheat(q, cheat('big_boom'), () => {});
		expect(q.inventory.big_tnt).toBe(57);
		const z = player({ big_tnt: 0 });
		applyCheat(z, cheat('big_boom'), () => {});
		expect(z.inventory.big_tnt).toBe(50);
	});

	it('is pure on its inputs and marks dirty exactly once (catches in-place mutation of a save in flight, a missing or double markDirty)', () => {
		const inv = { stone: 3 }, tools = { owned: [0], equipped: 0 };
		const p = player(inv, tools);
		const dirty = vi.fn();
		applyCheat(p, cheat('so_rich'), dirty);
		expect(dirty).toHaveBeenCalledTimes(1);
		expect(inv).toEqual({ stone: 3 });
		expect(tools).toEqual({ owned: [0], equipped: 0 });
		expect(p.inventory).not.toBe(inv);
		expect(p.inventory.deepslate_emerald_ore).toBe(500);
		expect(p.inventory.stone).toBe(3);
		applyCheat(p, cheat('mole_man'), dirty);
		expect(dirty).toHaveBeenCalledTimes(2);
	});

	it('never touches the hotbar (J2: grid only)', () => {
		const p = player();
		for (const c of CHEATS) applyCheat(p, c, () => {});
		expect(p.hotbar).toEqual([1, 2, 3]);
	});

	it('pickaxes: owned without duplicates, equipped only above the EQUIPPED tier (catches always-equip, never-equip, comparing with the best owned, or a duplicate)', () => {
		const run = (tools: PlayerTools, cid: string) => {
			const p = player({}, tools);
			const r = applyCheat(p, cheat(cid), () => {});
			return [p.tools, r.pickaxeChanged];
		};
		expect(run({ owned: [0], equipped: 0 }, 'mole_man')).toEqual([{ owned: [0, 4], equipped: 4 }, true]);
		expect(run({ owned: [0, 6], equipped: 6 }, 'mole_man')).toEqual([{ owned: [0, 4, 6], equipped: 6 }, false]);
		expect(run({ owned: [0, 6], equipped: 0 }, 'mole_man')).toEqual([{ owned: [0, 4, 6], equipped: 4 }, true]);
		expect(run({ owned: [0, 4], equipped: 4 }, 'mole_man')).toEqual([{ owned: [0, 4], equipped: 4 }, false]);
		expect(run({ owned: [0, 4, 6], equipped: 4 }, 'mole_power')).toEqual([{ owned: [0, 4, 6], equipped: 6 }, true]);
	});

	it('granted blocks become placeable (catches a grant to the wrong key)', () => {
		const p = player();
		applyCheat(p, cheat('big_boom'), () => {});
		applyCheat(p, cheat('so_rich'), () => {});
		expect(canPlace(p.inventory, BLOCK_BY_NAME.big_tnt.id, false)).toBe(true);
		expect(canPlace(p.inventory, BLOCK_BY_NAME.diamond_ore.id, true)).toBe(true);
	});
});
