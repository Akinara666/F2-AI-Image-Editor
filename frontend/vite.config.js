import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/generate': 'http://localhost:8000',
      '/prompt/transform': 'http://localhost:8000',
      '/outputs': 'http://localhost:8000',
      '/models': 'http://localhost:8000',
    }
  }
})
