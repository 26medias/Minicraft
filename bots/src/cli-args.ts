/**
 * Pure argv → flags parsing for the bot CLI (spec §4). Subcommand dispatch (`companion` vs `revert`)
 * is cli.ts's job (Task 4); this module only turns `--flag value` / `--flag` pairs into a typed
 * object. It never reads the real process argv itself — the caller injects the array.
 */

export interface ParsedArgs {
	target?: string;
	world?: string;
	name?: string;
	skin?: string;
	brain?: string;
	noEdits: boolean;
	revertOnExit: boolean;
	iDeployedTheServer: boolean;
}

type ValueFlagKey = 'target' | 'world' | 'name' | 'skin' | 'brain';
type BooleanFlagKey = 'noEdits' | 'revertOnExit' | 'iDeployedTheServer';

const VALUE_FLAGS: Record<string, ValueFlagKey> = {
	'--target': 'target',
	'--world': 'world',
	'--name': 'name',
	'--skin': 'skin',
	'--brain': 'brain',
};

const BOOLEAN_FLAGS: Record<string, BooleanFlagKey> = {
	'--no-edits': 'noEdits',
	'--revert-on-exit': 'revertOnExit',
	'--i-deployed-the-server': 'iDeployedTheServer',
};

/** Parses `--flag value` / `--flag` pairs. Throws a plain `Error` on an unrecognised or malformed flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const out: ParsedArgs = { noEdits: false, revertOnExit: false, iDeployedTheServer: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const valueKey = VALUE_FLAGS[arg];
		if (valueKey) {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			out[valueKey] = value;
			continue;
		}
		const boolKey = BOOLEAN_FLAGS[arg];
		if (boolKey) {
			out[boolKey] = true;
			continue;
		}
		throw new Error(`unknown flag: ${arg}`);
	}
	return out;
}
