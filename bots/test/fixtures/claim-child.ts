/**
 * A child process for plan-file.test.ts: once `<plan>.go` exists, claims lots of the plan at `argv[2]` as bot `argv[3]` until none is left,
 * marking each built at once, and prints every lot id it got. Many of these race on one plan file.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { claimLot, updateLot } from '../../src/foreman/plan-file.js';

const [path, bot] = process.argv.slice(2);
// Everyone starts at the same instant (the parent writes `go` once all are ready), so the claims really race.
writeFileSync(`${path}.ready-${bot}`, '');
while (!existsSync(`${path}.go`)) {
	// spin
}
const got: string[] = [];
for (;;) {
	const l = claimLot(path, bot, Date.now());
	if (!l) break;
	got.push(l.id);
	if (!updateLot(path, l.id, bot, Date.now(), { status: 'built' })) got.push(`LOST:${l.id}`);
}
process.stdout.write(`${JSON.stringify(got)}\n`);
