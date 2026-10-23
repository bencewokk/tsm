import { defineConfig, type Plugin } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Dev only: POST /__shot?name=foo with a PNG data URL saves screenshots/foo.png (used to capture the canvas at full size). */
function shots(): Plugin {
  return {
    name: 'tsm-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          const b64 = body.slice(body.indexOf(',') + 1);
          const dir = resolve(__dirname, 'screenshots');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.png`), Buffer.from(b64, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [shots()],
  server: { host: '127.0.0.1', port: 5173 },
  build: { chunkSizeWarningLimit: 1500 },
});
