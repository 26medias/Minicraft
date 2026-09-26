import { describe, expect, it } from 'vitest';
import { CRAFTED_ONLY, blockId, blockNames, isLiquidId } from 'minicraft-bot';
import { StopSignal } from '../../src/body/stop-signal.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { checkPlace } from '../../src/builder/builder.js';
import { JEV_URL, jevEngine, parseJevKey } from '../../src/builder/engines.js';
import { PALETTES } from '../../src/builder/palettes.data.js';
import { FakeWorld } from '../fake-port.js';

function setup() {
	const world = new FakeWorld();
	const x = 100, z = 100;
	const y = world.surfaceY(x, z) + 1;
	const owned: Record<string, number> = {};
	const own = new Ownership(world, () => owned);
	const stop = new StopSignal(600_000);
	const base = { world, own, kids: [] as Array<{ name: string; x: number; y: number; z: number }>, stop, now: 1_000_000, lastEditT: null, noEdits: false, halted: null };
	return { world, x, y, z, own, stop, base };
}

describe('builder safety (checkPlace)', () => {
	it('places into air with no kid around', () => {
		const { x, y, z, base } = setup();
		expect(checkPlace({ x, y, z }, 'oak_planks', base)).toEqual({ ok: true });
	});

	it('refuses on or next to a kid cell', () => {
		const { world, x, y, z, base } = setup();
		world.set(x + 1, y, z, 'dirt');
		expect(checkPlace({ x, y, z }, 'oak_planks', base)).toMatchObject({ ok: false, reason: 'kid cell buffer' });
	});

	it('refuses inside a kid body buffer', () => {
		const { x, y, z, base } = setup();
		const v = checkPlace({ x, y, z }, 'oak_planks', { ...base, kids: [{ name: 'Noah', x: x + 1.5, y, z: z + 0.5 }] });
		expect(v).toMatchObject({ ok: false, reason: 'kid body buffer' });
	});

	it('refuses within 16 of a kid who broke one of its blocks, and not after 10 min', () => {
		const { x, y, z, stop, base } = setup();
		const now = base.now;
		stop.onEdit({ by: 1, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 0, y: 70, z: 0, oldId: 5, newId: 0 }] }, [{ x: 0, y: 70, z: 0, oldId: 0, newId: 5, t: 0 }], now);
		const kids = [{ name: 'Noah', x: x + 10, y, z }];
		expect(checkPlace({ x, y, z }, 'oak_planks', { ...base, kids })).toMatchObject({ ok: false, reason: 'stop signal: Noah' });
		expect(checkPlace({ x, y, z }, 'oak_planks', { ...base, kids, now: now + 600_001 })).toEqual({ ok: true });
	});

	it('refuses a cell that is not air, --no-edits, and its own body', () => {
		const { world, x, y, z, base } = setup();
		expect(checkPlace({ x, y: y - 1, z }, 'oak_planks', base)).toMatchObject({ ok: false });
		expect(checkPlace({ x, y, z }, 'oak_planks', { ...base, noEdits: true })).toMatchObject({ ok: false, reason: '--no-edits' });
		expect(checkPlace({ x, y, z }, 'oak_planks', { ...base, self: { x: x + 0.5, y, z: z + 0.5 } })).toMatchObject({ ok: false, reason: 'own body' });
		expect(world.getBlock(x, y, z)).toBe(0);
	});
});

describe('builder engines', () => {
	it('Jev: the request shape, the answer mapping, and the key never in an error', async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const ok = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response(JSON.stringify({ answers: { next: { type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.8 } } } }), { status: 200 });
		}) as unknown as typeof fetch;
		const a = await jevEngine('SECRET-KEY', ok).choose('state text', 'pick one', { a: 'first', b: 'second' });
		expect(a).toEqual({ choice: 'b', probs: { a: 0.2, b: 0.8 } });
		expect(seen[0].url).toBe(JEV_URL);
		expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET-KEY');
		expect(JSON.parse(seen[0].init.body as string)).toEqual({
			model: 'jev-latest', state: 'state text', questions: { next: { type: 'choice', instructions: 'pick one', criteria: { a: 'first', b: 'second' } } },
		});
		const bad = (async () => new Response('nope SECRET', { status: 401 })) as unknown as typeof fetch;
		const err = await jevEngine('SECRET-KEY', bad).choose('s', 'i', { a: 'x' }).catch((e: Error) => e.message);
		expect(err).not.toContain('SECRET-KEY');
		const offList = (async () => new Response(JSON.stringify({ answers: { next: { choice: 'zzz' } } }), { status: 200 })) as unknown as typeof fetch;
		await expect(jevEngine('k', offList).choose('s', 'i', { a: 'x' })).rejects.toThrow(/not an offered option/);
	});

	it('parses the JEV_API_KEY line, cleaning quotes, \\r and stray characters', () => {
		expect(parseJevKey('A=1\nJEV_API_KEY="apikey_12ab_cd" \r\nB=2')).toBe('apikey_12ab_cd');
		expect(parseJevKey('A=1')).toBeNull();
		expect(parseJevKey(null)).toBeNull();
	});
});

describe('palettes', () => {
	it('every block is a real, placeable catalog name (no liquid, no crafted-only)', () => {
		const known = new Set(blockNames());
		for (const p of PALETTES) for (const b of Object.values(p.blocks)) {
			expect(known.has(b), `${p.name}: ${b}`).toBe(true);
			expect(isLiquidId(blockId(b)!), b).toBe(false);
			expect(CRAFTED_ONLY.includes(b), b).toBe(false);
		}
	});
});
