import { defineConfig } from 'vite';
import react      from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { readFileSync } from 'fs';
import { resolve } from 'path';

// גרסת האפליקציה מ-backend/package.json (מקור האמת) + build timestamp
const backendPkg = JSON.parse(readFileSync(resolve(__dirname, '../backend/package.json'), 'utf8'));
const APP_VERSION = backendPkg.version;
const BUILD_ID = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',   // IPv4 במפורש, לא ::1
    proxy: {
      // בפיתוח — כל בקשות /api מנותבות לbackend
      '/api': {
        target:      'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir:    '../frontend/dist',  // ה-dist נבנה בתוך frontend/
    emptyOutDir: true,
  }
});
