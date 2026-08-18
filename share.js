#!/usr/bin/env node
// `npm run share` — run the game on this computer AND get a public https link that
// friends anywhere can open, without deploying anything.
//
// How: it starts the normal server, then opens a free Cloudflare "quick tunnel" to it
// (a temporary public URL that forwards to your PC; supports WebSockets, no account
// needed). The link works for as long as this window stays open. If cloudflared can't
// be fetched, it falls back to localtunnel.
//
// Nothing here is needed for a real deployment — see DEPLOY.md / SHARE.md for that.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const isWin = process.platform === 'win32';

function banner(url) {
  const line = '═'.repeat(Math.max(40, url.length + 6));
  console.log(`\n${line}\n  🏴‍☠️  Share this link with your friends:\n\n     ${url}\n\n  Keep this window open while you play. Ctrl+C to stop.\n${line}\n`);
  console.log(`(You can also open http://localhost:${PORT} yourself.)\n`);
}

// 1. start the game server in-process
process.env.PORT = String(PORT);
require(path.join(__dirname, 'server', 'index.js'));

// 2. open a tunnel
setTimeout(startTunnel, 800);

function startTunnel() {
  console.log('\nOpening a public tunnel… (first run downloads a small helper — may take a moment)\n');
  tryCloudflared().catch(() => tryLocaltunnel()).catch((e) => {
    console.log('\nCould not open a tunnel automatically:', e.message);
    console.log('Fallbacks:\n  • Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run:\n      cloudflared tunnel --url http://localhost:' + PORT + '\n  • Or deploy it properly — see SHARE.md (5 minutes, free).');
  });
}

function runAndGrab(cmd, args, urlRegex, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let found = false, out = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      out += text;
      const m = text.match(urlRegex);
      if (m && !found) { found = true; banner(m[0]); resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { if (!found) reject(e); });
    child.on('exit', (code) => { if (!found) reject(new Error(`${label} exited (${code}). Output: ${out.slice(-300)}`)); });
    setTimeout(() => { if (!found) { try { child.kill(); } catch (e) {} reject(new Error(`${label} took too long to start`)); } }, 90000);
    process.on('exit', () => { try { child.kill(); } catch (e) {} });
    process.on('SIGINT', () => { try { child.kill(); } catch (e) {} process.exit(0); });
  });
}

async function tryCloudflared() {
  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  // installed binary first (fast), else fetch via npx (the "cloudflared" npm package downloads the official binary)
  try { return await runAndGrab('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], re, 'cloudflared'); }
  catch (e) { return await runAndGrab(isWin ? 'npx.cmd' : 'npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], re, 'npx cloudflared'); }
}
async function tryLocaltunnel() {
  console.log('cloudflared unavailable — trying localtunnel instead (friends may see a one-time "click to continue" page).');
  return runAndGrab(isWin ? 'npx.cmd' : 'npx', ['--yes', 'localtunnel', '--port', String(PORT)], /https:\/\/[a-z0-9-]+\.loca\.lt/, 'localtunnel');
}
