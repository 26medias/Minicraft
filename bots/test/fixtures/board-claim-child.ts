/**
 * A child process for board.test.ts: once `<board>.go` exists, claims 'flat-needed' posts of the board at `argv[2]` as
 * bot `argv[3]` until none is left, completing each at once, and prints every post id it got. Many race on one file.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { claimNext, complete } from '../../src/board/board.js';

const [path, bot] = process.argv.slice(2);
writeFileSync(`${path}.ready-${bot}`, '');
while (!existsSync(`${path}.go`)) {
	// spin
}
const got: string[] = [];
for (;;) {
	const p = claimNext(path, 'flat-needed', bot, Date.now());
	if (!p) break;
	got.push(p.id);
	if (!complete(path, p.id, bot, Date.now())) got.push(`LOST:${p.id}`);
}
process.stdout.write(`${JSON.stringify(got)}\n`);
