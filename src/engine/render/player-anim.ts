/** Joint angles in vanilla convention (y-down model space: positive xRot swings a limb back). */
export type Joints = { headX: number; rArmX: number; rArmZ: number; lArmX: number; lArmZ: number; rLegX: number; lLegX: number };
export const ZERO_JOINTS: Readonly<Joints> = { headX: 0, rArmX: 0, rArmZ: 0, lArmX: 0, lArmZ: 0, rLegX: 0, lLegX: 0 };
