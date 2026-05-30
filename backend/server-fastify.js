/**
 * Optional Fastify entry — run after `npm install`: npm run start:fastify
 */
import Fastify from 'fastify';
import { registerAnalyzeRoutes } from './routes/analyze.js';

const PORT = Number(process.env.PORT) || 3000;
const fastify = Fastify({ logger: true });

fastify.addHook('onRequest', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
});

fastify.options('*', async (_request, reply) => reply.code(204).send());

fastify.get('/v1/health', async () => ({
  ok: true,
  service: 'ecohealth-backend',
  version: '1.0.0',
}));

await registerAnalyzeRoutes(fastify);
await fastify.listen({ port: PORT, host: '0.0.0.0' });
