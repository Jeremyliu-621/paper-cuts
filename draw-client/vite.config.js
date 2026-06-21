import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

const backendTarget = process.env.VITE_BACKEND_URL || 'http://localhost:8000'

function httpsConfig() {
  const cert = process.env.MAGICBOARD_TLS_CERT
  const key = process.env.MAGICBOARD_TLS_KEY
  if (!cert || !key) return undefined
  return {
    cert: fs.readFileSync(cert),
    key: fs.readFileSync(key),
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    https: httpsConfig(),
    proxy: {
      '/agent': backendTarget,
      '/rooms': backendTarget,
      '/selection': backendTarget,
      '/ws': {
        target: backendTarget,
        ws: true,
      },
    },
  },
  preview: {
    host: true,
    https: httpsConfig(),
  },
})
