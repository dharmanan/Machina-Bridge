import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: 'localhost',
  },
  optimizeDeps: {
    esbuildOptions: {
      supported: {
        'import-meta': true,
        'top-level-await': true,
      },
      sourcemap: false,
    },
    exclude: ['@base-org/account'],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          wagmi: ['wagmi'],
        },
      },
    },
  },
})
