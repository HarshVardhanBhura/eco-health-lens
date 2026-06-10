import { createServer } from 'http';

const PORT = Number(process.env.PORT) || 3000;

console.log('[EcoHealth] starting…');

process.on('unhandledRejection', (reason) => {
  console.error('[EcoHealth] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[EcoHealth] uncaughtException:', err);
});

/**
 * @param {import('http').IncomingMessage} req
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} code
 * @param {object} data
 */
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(res, 200, {
      status: 'ok',
      ok: true,
      service: 'ecohealth-backend',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/analyze') {
    try {
      // Lazy-load analysis stack (sharp, tesseract) so /v1/health is ready
      // immediately on cold start — important for Render free-tier deploys.
      const { analyzeProduct } = await import('./routes/analyze.js');
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      if (!payload.retailer) {
        sendJson(res, 400, { error: 'retailer is required' });
        return;
      }
      if (!payload.asin && !payload.barcode) {
        sendJson(res, 400, { error: 'asin or barcode is required' });
        return;
      }
      const result = await analyzeProduct(payload);
      sendJson(res, 200, result);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: 'Analysis failed' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  console.error('[EcoHealth] server failed to start:', err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[EcoHealth] API listening on port ${PORT}`);
});
