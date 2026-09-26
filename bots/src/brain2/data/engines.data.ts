import type { EngineChoice } from '../experts/expert.js';
/** Chosen by `npm run bot:bench` and Julien (spec §9.2, R15). Until then: code for everything. */
export const ENGINES: { appraiseDetect: EngineChoice; appraiseDetectWording: 'three-way' | 'binary' | 'batched' | 'few-shot'; appraiseSize: EngineChoice; social: EngineChoice; fit: EngineChoice; situational: EngineChoice; paramsBuild: EngineChoice; paramsMine: EngineChoice; measured: string } = {
	appraiseDetect: 'code', appraiseDetectWording: 'binary', appraiseSize: 'code', social: 'code', fit: 'code', situational: 'code', paramsBuild: 'code', paramsMine: 'code',
	measured: 'not yet',
};
