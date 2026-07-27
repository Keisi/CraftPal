import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Which game's data.js resolves at build time (PLAN.md §9): "one Pages
// deploy per game" — read here (Node-side process.env, NOT the client-side
// import.meta.env) because this decision must happen at CONFIG load time,
// before Rollup ever sees a module graph.
//
// Why an alias instead of `REGISTRY = { palworld: {...}, minecraft: {...} }`
// with both games' JSON statically imported in src/lib/data.js: measured
// directly (build the default Palworld bundle before vs. after registering
// a second game) — with BOTH games' JSON unconditionally imported into one
// object literal, the default Palworld build grew from 1,022 KB to 1,275 KB
// (+253 KB / +25%), because Rollup/Rolldown does not eliminate an object
// property just because nothing ends up reading it at a dynamic `REGISTRY[key]`
// — that requires whole-module reachability, not property-level analysis.
// Aliasing `virtual:game-data` to ONLY the selected game's
// src/data/<game>/index.js means the other game's JSON is never even
// present in the resolved module graph for a given build — provably, not
// "hopefully tree-shaken" — restoring the original single-game bundle size.
const GAME = process.env.VITE_GAME || 'palworld'

// https://vite.dev/config/
// Production builds are served from GitHub Pages at /CraftPal/ — runtime
// asset URLs must go through import.meta.env.BASE_URL (see ItemIcon.jsx).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/CraftPal/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      'virtual:game-data': path.resolve(__dirname, `src/data/${GAME}/index.js`),
    },
  },
}))
