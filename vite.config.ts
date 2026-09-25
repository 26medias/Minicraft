import { defineConfig } from 'vite';

// Relative base so the bundle works at any subpath (e.g. /minecraft/)
// without re-building. Pages load assets relative to the HTML file's URL.
export default defineConfig({
	base: './',
	cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
	server: { port: 5173, strictPort: true },
	build: { target: 'es2022', sourcemap: true },
});
