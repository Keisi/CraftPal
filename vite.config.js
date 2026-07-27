import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Production builds are served from GitHub Pages at /CraftPal/ — runtime
// asset URLs must go through import.meta.env.BASE_URL (see ItemIcon.jsx).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/CraftPal/' : '/',
  plugins: [react(), tailwindcss()],
}))
