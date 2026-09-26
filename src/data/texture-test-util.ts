// src/data/texture-test-util.ts
import { decodePng } from './texture-png';
export const readTile = (name: string): Promise<Uint8Array> => decodePng(`src/assets/blocks/${name}.png`);
