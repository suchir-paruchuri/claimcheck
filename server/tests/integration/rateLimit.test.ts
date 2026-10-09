import request from 'supertest';
import { createApp } from '../../src/app';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

// Its own file, so the limiter's in-memory counter starts fresh.
const app = createApp();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  process.env.AUTH_RATE_LIMIT = '3';
  await connectTestDb();
}, 60_000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('blocks repeated sign-in attempts from the same address', async () => {
  const attempt = () => request(app).post('/auth/login').send({ email: 'target@example.com', password: 'guess-number-xyz' });
  for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
  expect((await attempt()).status).toBe(429);
});
