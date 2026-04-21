export type PointerState = {
	locked: boolean;
	onChange: (locked: boolean) => void;
};

export function setupPointerLock(
	canvas: HTMLElement,
	onMouseMove: (dx: number, dy: number) => void,
): PointerState {
	const state: PointerState = { locked: false, onChange: () => {} };

	canvas.addEventListener('click', () => {
		if (!state.locked) canvas.requestPointerLock();
	});

	document.addEventListener('pointerlockchange', () => {
		state.locked = document.pointerLockElement === canvas;
		state.onChange(state.locked);
	});

	document.addEventListener('mousemove', (e) => {
		if (!state.locked) return;
		onMouseMove(e.movementX, e.movementY);
	});

	return state;
}
