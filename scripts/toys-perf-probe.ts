/**
 * Toys spec §6 "Perf": a headless probe (node, no GPU, no worker: every mesh is synchronous) of stats.lightMs and the
 * main-thread tick time of Flattening TNT and Lake TNT against Mega TNT, at the same v3 site, each on a fresh world.
 *
 *   npx tsx scripts/toys-perf-probe.ts [seed] [runs]
 *
 * Sites: SITES below. Per toy and site: settle streaming, place and ignite the TNT, then tick at 1/60 s until the bulk lane drains. It
 * reports the blast's light time (stats.lightMs delta), the detonation frame's tick time, the worst tick after it, the
 * frames until the bulk lane is empty, and the cells removed and placed. Median over `runs`. The gate: neither toy's
 * light time nor worst tick exceeds Mega's at the same site. Absolute numbers are for comparison only (the real-GPU
 * perf:bench row is phase P's).
 */
import { makeLoop } from '../src/game/test-loop';
import { BLOCK_BY_NAME, isSolid } from '../src/data/blocks.data';
import type { World } from '../src/engine/world/world';

const seed = Number(process.argv[2] ?? 3);
const runs = Number(process.argv[3] ?? 3);
const SITE = { x: 21 * 16 + 8, z: 12 * 16 + 8 };
const TOYS = ['mega_tnt', 'flatten_tnt', 'lake_tnt'] as const;
/** surface: on the ground (top + 1). buried: 6 under it. deep: 14 under it, where Flatten's whole cylinder is solid (its worst case). */
const SITES = { surface: 1, buried: -6, deep: -14 } as const;
type Site = keyof typeof SITES;

const top = (w: World, x: number, z: number) => { for (let y = w.height - 1; y > 0; y--) if (isSolid(w.getBlock(x, y, z))) return y; return 0; };
const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

type Row = { lightMs: number; blastTickMs: number; worstTickMs: number; frames: number; removed: number; placed: number };

function once(name: typeof TOYS[number], site: Site): Row {
	const h = makeLoop({ seed });
	const t = top(h.world, SITE.x, SITE.z);
	h.player.flying = true;
	h.player.position = [SITE.x + 20.5, t + 12, SITE.z + 0.5]; // 20 blocks east, clear of every blast
	// Settle streaming: the queue stays empty and nothing mounts for 5 ticks in a row.
	for (let k = 0, quiet = 0, m = h.mounts(); k < 2000 && quiet < 5; k++) {
		h.tick(1 / 60);
		quiet = h.loop.stats.streamQueue === 0 && h.mounts() === m ? quiet + 1 : 0;
		m = h.mounts();
	}
	const o = { x: SITE.x, y: t + SITES[site], z: SITE.z };
	h.world.setBlock(o.x, o.y, o.z, BLOCK_BY_NAME[name].id);
	h.loop.applyLightUpdate(o.x, o.y, o.z);
	for (let i = 0; i < 5; i++) h.tick(1 / 60);
	let removed = 0;
	h.loop.onBlocksRemoved = (r) => { removed += r.length; };
	const ticks: number[] = [];
	h.loop.onFrame = (_dt, tickMs) => { ticks.push(tickMs); };
	const fuse = BLOCK_BY_NAME[name].tnt!.fuse;
	if (!h.loop.ignite({ ...o, face: 'py', distance: 1 }, 0)) throw new Error(`${name}: ignite refused`);
	h.tick(fuse - 0.05); // no blast yet
	ticks.length = 0;
	const light0 = h.loop.stats.lightMs;
	const countWater = () => { let n = 0; for (let x = o.x - 8; x <= o.x + 8; x++) for (let y = o.y - 12; y <= o.y + 13; y++) for (let z = o.z - 8; z <= o.z + 8; z++) if (h.world.getBlock(x, y, z) === BLOCK_BY_NAME['water'].id) n++; return n; };
	const water0 = countWater();
	let frames = 0;
	for (; frames < 600; frames++) {
		h.tick(1 / 60);
		if (frames > 3 && h.loop.stats.bulkQueue === 0 && h.loop.stats.editQueue === 0) break;
	}
	const lightMs = h.loop.stats.lightMs - light0;
	if (h.world.getBlock(o.x, o.y, o.z) === BLOCK_BY_NAME[name].id) throw new Error(`${name}: did not go off`);
	return { lightMs, blastTickMs: Math.max(...ticks.slice(0, 3)), worstTickMs: Math.max(...ticks), frames, removed, placed: countWater() - water0 };
}

console.log(`seed ${seed}, site (${SITE.x}, ${SITE.z}), median of ${runs} runs, node (no GPU, synchronous meshing)`);
console.log('site     toy           lightMs  blastTick  worstTick  frames  removed  water');
for (const site of Object.keys(SITES) as Site[]) {
	const results = new Map<string, Row>();
	for (const name of TOYS) {
		const rs: Row[] = [];
		for (let i = 0; i < runs; i++) rs.push(once(name, site));
		const row: Row = {
			lightMs: median(rs.map((r) => r.lightMs)), blastTickMs: median(rs.map((r) => r.blastTickMs)), worstTickMs: median(rs.map((r) => r.worstTickMs)),
			frames: median(rs.map((r) => r.frames)), removed: rs[0].removed, placed: rs[0].placed,
		};
		results.set(name, row);
		console.log(`${site.padEnd(8)} ${name.padEnd(12)} ${row.lightMs.toFixed(1).padStart(8)} ${row.blastTickMs.toFixed(1).padStart(10)} ${row.worstTickMs.toFixed(1).padStart(10)} ${String(row.frames).padStart(7)} ${String(row.removed).padStart(8)} ${String(row.placed).padStart(6)}`);
	}
	const mega = results.get('mega_tnt')!;
	for (const name of ['flatten_tnt', 'lake_tnt'] as const) {
		const r = results.get(name)!;
		const ok = r.lightMs <= mega.lightMs && r.worstTickMs <= mega.worstTickMs;
		console.log(`  ${site} ${name}: light ${(r.lightMs / mega.lightMs * 100).toFixed(0)}% of Mega, worst tick ${(r.worstTickMs / mega.worstTickMs * 100).toFixed(0)}% of Mega → ${ok ? 'PASS' : 'OVER MEGA'}`);
		if (!ok) process.exitCode = 1;
	}
}
