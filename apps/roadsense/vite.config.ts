import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// Relative base so the build works unmodified under any GitHub Pages path
// (https://<user>.github.io/<repo>/) without hardcoding the repo name, and
// still works at the domain root or from any other static host.
//
// `npm run dev:phone` serves over HTTPS on the LAN: phones only hand out
// geolocation (and wake lock / speech) to secure origins, so testing the
// real GPS navigation on a device needs this, not plain `npm run dev`.
export default defineConfig({
  base: './',
  plugins: [react(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: { host: process.env.HTTPS ? true : undefined },
})
