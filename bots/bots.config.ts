/**
 * Bot targets, brain servers and companion tuning. Committed — no secrets (the live token comes from
 * `MC_LIVE_TOKEN` or `bots/.env.live` at runtime; see .env.example). See spec §4 and §12a (§12a's
 * companion tuning overrides §4's).
 */
export default {
	targets: {
		local: { url: 'http://localhost:18090', token: 'e2e' },
		live: { url: 'https://minicraft-server.leap-forward.ca', tokenEnv: 'MC_LIVE_TOKEN', tokenFile: '~/minicraft-mp/token' },
	},
	brains: {
		laya: { url: 'http://127.0.0.1:8000', health: 'TODO_FROM_BRAINS_MD', home: '~/Projects/AI/laya', start: ['TODO_FROM_BRAINS_MD'], timeoutMs: 400 },
		clm: { url: 'http://127.0.0.1:8700', health: 'TODO_FROM_BRAINS_MD', home: '~/Projects/AI/clm', start: ['TODO_FROM_BRAINS_MD'], timeoutMs: 400 },
	},
	companion: {
		tickMs: 500,
		editEveryMs: 2000,
		editBudget: 50,
		followDist: 2,
		minConfidence: 0.4,
		stopMs: 600_000,
		wanderTether: 12,
		statusEveryMs: 30_000,
	},
};
