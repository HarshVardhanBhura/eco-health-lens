const BASE = process.env.API_URL || 'http://localhost:3000';

async function main() {
  try {
    const res = await fetch(`${BASE}/v1/health`);
    const data = await res.json();
    if (res.ok && (data.status === 'ok' || data.ok === true)) {
      console.log('Health check OK:', data);
      process.exit(0);
    }
    console.error('Health check failed:', res.status, data);
    process.exit(1);
  } catch (e) {
    console.error('Health check error:', e.message);
    console.error('Start the server with: npm start');
    process.exit(1);
  }
}

main();
