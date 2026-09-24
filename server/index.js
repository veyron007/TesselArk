import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createApp } = require('./api.cjs');
const express = require('express');

if (!['demo', 'production'].includes(process.env.ERP_AUTH_MODE)) {
  throw new Error('Set ERP_AUTH_MODE=demo or ERP_AUTH_MODE=production explicitly before starting the server.');
}
const port = Number(process.env.PORT || 3001);
const host = process.env.ERP_HOST || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('ERP API may only bind to loopback; place an HTTPS reverse proxy in front of production auth.');
}
const app = createApp({ authOptions: { trustedProxyIps: process.env.ERP_AUTH_TRUSTED_PROXY_IPS || '' } });
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(port, host, () => console.log(`ERP API listening on http://${host}:${port} (${process.env.ERP_AUTH_MODE === 'production' ? 'production auth' : 'demo auth'})`));

export { app };
