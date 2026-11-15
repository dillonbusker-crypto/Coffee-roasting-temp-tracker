// Shared helpers for the browser tests: a tiny static server and a Chromium launcher (global Playwright, nothing installed).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.svg': 'image/svg+xml',
};

function startServer(root = ROOT) {
  const srv = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const type = TYPES[path.extname(f)] || 'application/octet-stream';
      const range = req.headers.range; // video seeking in Chromium wants range support
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m[1] ? parseInt(m[1], 10) : 0, end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        fs.createReadStream(f, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size });
        fs.createReadStream(f).pipe(res);
      }
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function launch(opts = {}) {
  const { chromium } = require('playwright');
  return chromium.launch(opts);
}

module.exports = { ROOT, startServer, launch };
