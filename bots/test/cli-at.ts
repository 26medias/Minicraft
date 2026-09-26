/**
 * The real CLI (`src/cli.ts` main, same argv) with the `local` target redirected to our own e2e server: the committed
 * `local` port (18090) may be another session's server, so a leg that runs the CLI on a free port goes through this.
 *
 *   BOTS_E2E_URL=http://127.0.0.1:<port> BOTS_E2E_STATE=<scratch state root> tsx test/cli-at.ts companion --target local …
 *
 * Only the client's URL and the state root change; the token, commands and everything else are the CLI's own.
 */
import { readFileSync } from 'node:fs';
import { BotClient } from 'minicraft-bot';
import botsConfig from '../bots.config.js';
import { main } from '../src/cli.js';

const url = process.env.BOTS_E2E_URL ?? '';
const stateRoot = process.env.BOTS_E2E_STATE ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || url.endsWith(':8080') || stateRoot === '') {
	console.error('cli-at: set BOTS_E2E_URL=http://127.0.0.1:<port> (not 8080) and BOTS_E2E_STATE');
	process.exit(2);
}
const local = botsConfig.targets.local.url;

main(process.argv.slice(2), {
	makeClient: (o) => {
		if (o.url !== local) throw new Error(`cli-at: only the local target is redirected (got ${o.url})`);
		return new BotClient({ ...o, url });
	},
	stateRoot,
	env: process.env,
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	print: (line) => console.log(line),
}).catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
