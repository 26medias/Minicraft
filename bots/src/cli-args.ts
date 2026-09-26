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
	/** `--personality pip|rex` (brain v2). */
	personality?: string;
	noEdits: boolean;
	revertOnExit: boolean;
	iDeployedTheServer: boolean;
	/** `revert --builds` (brain v2): take the bot's standing builds apart instead of replaying the journal. */
	builds: boolean;
	/** `--tui` (brain v2): the live terminal view. */
	tui: boolean;
	/** `--compare` (builder): ask both Laya and Jev, act on the primary, log both. */
	compare: boolean;
	/** `--rest-sec N` (builder): the rest after each finished build, in seconds. */
	restSec?: string;
	/** `--jev` (brain v2, experiment E2): Jev answers selection's social and situational questions. */
	jev: boolean;
	/** `--llm-params` (architect, experiment E6): Ollama proposes the design's numbers before the choices. */
	llmParams: boolean;
	/** `--max-builds N` (builder, architect, helper): stop building after N builds (counted across restarts). */
	maxBuilds?: string;
	/** `--max-decorations N` (decorator): stop decorating after N decorations (counted across restarts). */
	maxDecorations?: string;
	/** `--max-blasts N` (landscaper): stop after N blasts (counted across restarts). */
	maxBlasts?: string;
	/** `--join-plan` (builder, architect, experiment E7): claim the next open lot of the foreman's plan first. */
	joinPlan: boolean;
	/** `--when always|players` (every bot): with `players`, active only while a non-bot player is online. */
	when?: string;
}

type ValueFlagKey = 'target' | 'world' | 'name' | 'skin' | 'brain' | 'personality' | 'restSec' | 'maxBuilds' | 'maxDecorations' | 'maxBlasts' | 'when';
type BooleanFlagKey = 'noEdits' | 'revertOnExit' | 'iDeployedTheServer' | 'builds' | 'tui' | 'compare' | 'jev' | 'llmParams' | 'joinPlan';

const VALUE_FLAGS: Record<string, ValueFlagKey> = {
	'--target': 'target',
	'--world': 'world',
	'--name': 'name',
	'--skin': 'skin',
	'--brain': 'brain',
	'--personality': 'personality',
	'--rest-sec': 'restSec',
	'--max-builds': 'maxBuilds',
	'--max-decorations': 'maxDecorations',
	'--max-blasts': 'maxBlasts',
	'--when': 'when',
};

const BOOLEAN_FLAGS: Record<string, BooleanFlagKey> = {
	'--no-edits': 'noEdits',
	'--revert-on-exit': 'revertOnExit',
	'--i-deployed-the-server': 'iDeployedTheServer',
	'--builds': 'builds',
	'--tui': 'tui',
	'--compare': 'compare',
	'--jev': 'jev',
	'--llm-params': 'llmParams',
	'--join-plan': 'joinPlan',
};

/** Parses `--flag value` / `--flag` pairs. Throws a plain `Error` on an unrecognised or malformed flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const out: ParsedArgs = { noEdits: false, revertOnExit: false, iDeployedTheServer: false, builds: false, tui: false, compare: false, jev: false, llmParams: false, joinPlan: false };
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
