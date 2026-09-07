import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolveElevenLabsScribeEntry } from './scripts/elevenlabs-guard.ts'

const elevenLabsScribeEntry = resolveElevenLabsScribeEntry(import.meta.url)

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: [
      {
        // 精确匹配 '@elevenlabs/client'，不影响子路径；定向至经构建守卫校验的 Scribe 独立入口
        find: /^@elevenlabs\/client$/,
        replacement: elevenLabsScribeEntry,
      },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 仅对浏览器专属的实际大依赖分包；zod 留各入口自身，避免 Worker 生成额外 vendor chunk
          if (id.includes('/node_modules/')) {
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react'
            }
            if (id.includes('/node_modules/@elevenlabs/')) {
              return 'vendor-elevenlabs'
            }
            if (id.includes('/node_modules/lucide-react/')) {
              return 'vendor-lucide'
            }
          }
        },
      },
    },
  },
})
