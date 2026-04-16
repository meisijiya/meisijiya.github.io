const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const PHOTOS_FILE = path.join(__dirname, 'photos.js');

const MIME_TYPES = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/photos') {
    try {
      const photos = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(photos));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/photos') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const photos = JSON.parse(body);
        fs.writeFileSync(PHOTOS_FILE, JSON.stringify(photos, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] || 'text/plain';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`照片墙服务器已启动: http://localhost:${PORT}`);
  console.log(`照片墙: http://localhost:${PORT}/index.html`);
  console.log(`编辑器: http://localhost:${PORT}/editor.html`);
  console.log(`\n按 Ctrl+C 停止服务器`);
});