// Minimal HTTP plumbing: router, JSON body parsing, cookies, static file serving.
// Kept dependency-free on purpose — see package.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const cookieStr = parts.join('; ');
  if (existing) {
    res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', cookieStr);
  }
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

class Router {
  constructor() {
    this.routes = []; // { method, pattern (regex), keys, handler }
  }
  _add(method, path, handler) {
    const keys = [];
    const pattern = new RegExp(
      '^' +
        path
          .replace(/\/:[^/]+/g, (m) => {
            keys.push(m.slice(2));
            return '/([^/]+)';
          })
          .replace(/\//g, '\\/') +
        '$'
    );
    this.routes.push({ method, pattern, keys, handler });
  }
  get(path, handler) { this._add('GET', path, handler); }
  post(path, handler) { this._add('POST', path, handler); }
  put(path, handler) { this._add('PUT', path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  async handle(req, res, pathname) {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      try {
        await route.handler(req, res);
      } catch (err) {
        console.error('Route error:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      }
      return true;
    }
    return false;
  }
}

function serveStatic(rootDir) {
  return function (req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    // no query strings reach here (caller strips them)
    const filePath = path.normalize(path.join(rootDir, rel));
    if (!filePath.startsWith(path.normalize(rootDir))) {
      res.writeHead(403); res.end('Forbidden'); return true;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return true;
  };
}

function requestUrl(req) {
  return new URL(req.url, 'http://internal');
}

module.exports = { Router, serveStatic, parseCookies, setCookie, readJsonBody, sendJson, requestUrl };
