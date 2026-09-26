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
		// Verified working end-to-end (~/Projects/AI/BRAINS.md, 2026-09-25). `env NAME=value ... laya-serve`
		// is the exact start command from BRAINS.md, spawned with no shell (brains-cli.ts): `env` sets the
		// vars and execs the real binary, so BrainDef needs no separate `env` field. LAYA_MODELS=english is required
		// (spec §3.2; brains-cli.ts refuses without it): all three checkpoints push the LLM partly off the GPU.
		laya: {
			url: 'http://127.0.0.1:8000',
			health: '/health',
			home: '~/Projects/AI/laya',
			start: ['env', 'LAYA_HOST=127.0.0.1', 'LAYA_PORT=8000', 'LAYA_DEVICE=cuda', 'LAYA_PRELOAD=1', 'LAYA_MODELS=english', '.venv/bin/laya-serve'],
			timeoutMs: 400,
		},
		// experimental: true — clm-serve itself runs fine, but its required Qwen3-8B vLLM pooling
		// encoder does not fit this machine's 10 GiB RTX 3080 (a genuine CUDA OOM, not a config
		// mistake); the decision endpoint 502s without it. See ~/Projects/AI/BRAINS.md.
		clm: {
			url: 'http://127.0.0.1:8701',
			health: '/health',
			home: '~/Projects/AI/clm',
			start: ['env', 'CLM_PORT=8701', 'CLM_EMB_URL=http://127.0.0.1:8091/v1/embeddings', 'CLM_DEVICE=cuda', '.venv/bin/clm-serve', '--no-ui'],
			timeoutMs: 400,
			experimental: true,
		},
	},
	// Brain v2's local LLM (part 2; spec §3): Ollama, temperature 0, seed 42, keep_alive −1 set per call.
	llm: { url: 'http://127.0.0.1:11434', model: 'llama3.2:3b', timeoutMs: 5000 },
	companion: {
		tickMs: 500,
		editEveryMs: 2000,
		editBudget: 50,
		followDist: 2,
		minConfidence: 0.4,
		stopMs: 600_000,
		wanderTether: 12,
		statusEveryMs: 30_000,
		idleSwitchMs: 30_000,
		minTargetMs: 20_000,
	},
};
