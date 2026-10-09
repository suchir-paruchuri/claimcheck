import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Bill } from '../../src/models/Bill';
import { User } from '../../src/models/User';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

// External services are replaced: no S3 calls and no job queue during these tests.
jest.mock('../../src/services/storage', () => ({
  presignUpload: jest.fn(async () => 'https://s3.test/presigned-upload'),
  deleteFile: jest.fn(async () => undefined),
}));
jest.mock('../../src/jobs/queue', () => ({
  ...jest.requireActual('../../src/jobs/queue'),
  enqueue: jest.fn(async () => undefined),
}));

const JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const app = createApp();

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AUTH_RATE_LIMIT = '1000';
  await connectTestDb();
}, 60_000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** Signs up a user and returns a cookie-keeping agent for their session. */
async function signedInAgent(email: string, password = 'correct-horse-battery') {
  const agent = request.agent(app);
  const res = await agent.post('/auth/signup').send({ name: 'Test User', email, password });
  expect(res.status).toBe(201);
  return agent;
}

async function createBill(agent: ReturnType<typeof request.agent>) {
  const res = await agent.post('/bills').send({ filename: 'bill.pdf' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('sign-up and sign-in', () => {
  it('stores a bcrypt hash, never the password, and sets an httpOnly session cookie', async () => {
    const res = await request(app).post('/auth/signup').send({ name: 'Pat', email: 'Pat@Example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie'][0]).toMatch(/cc_session=.+HttpOnly/);

    const user = await User.findOne({ email: 'pat@example.com' }).lean();
    expect(user!.passwordHash).not.toContain('correct-horse-battery');
    expect(await bcrypt.compare('correct-horse-battery', user!.passwordHash)).toBe(true);
  });

  it('rejects a duplicate email and a short password', async () => {
    await signedInAgent('dup@example.com');
    expect((await request(app).post('/auth/signup').send({ name: 'X', email: 'dup@example.com', password: 'another-long-password' })).status).toBe(409);
    expect((await request(app).post('/auth/signup').send({ name: 'X', email: 'new@example.com', password: 'short' })).status).toBe(400);
  });

  it('signs in with the right password', async () => {
    await signedInAgent('a@example.com');
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/cc_session=/);
  });

  it('gives the same answer for a wrong password and an unknown email, so accounts cannot be discovered', async () => {
    await signedInAgent('a@example.com');
    const wrongPassword = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong-password-123' });
    const unknownEmail = await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('ends the session on logout', async () => {
    const agent = await signedInAgent('a@example.com');
    expect((await agent.get('/auth/me')).status).toBe(200);
    await agent.post('/auth/logout');
    expect((await agent.get('/auth/me')).status).toBe(401);
  });
});

describe('session verification', () => {
  const tokenFor = (secret: string, options: jwt.SignOptions = {}) =>
    jwt.sign({ sub: '507f1f77bcf86cd799439011', email: 'x@example.com' }, secret, { expiresIn: 3600, ...options });

  it('rejects requests with no session', async () => {
    expect((await request(app).get('/bills')).status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const res = await request(app).get('/bills').set('Cookie', `cc_session=${tokenFor('attacker-secret')}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const res = await request(app).get('/bills').set('Cookie', `cc_session=${tokenFor(JWT_SECRET, { expiresIn: -10 })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered token', async () => {
    const [header, , signature] = tokenFor(JWT_SECRET).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'someone-else', email: 'x@example.com' })).toString('base64url');
    const res = await request(app).get('/bills').set('Cookie', `cc_session=${header}.${forgedPayload}.${signature}`);
    expect(res.status).toBe(401);
  });
});

describe('bill ownership', () => {
  it("lets the owner read their bill without exposing the storage key", async () => {
    const alice = await signedInAgent('alice@example.com');
    const id = await createBill(alice);
    const res = await alice.get(`/bills/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.fileKey).toBeUndefined();
  });

  it("returns not found for every route on another user's bill", async () => {
    const alice = await signedInAgent('alice@example.com');
    const bob = await signedInAgent('bob@example.com');
    const id = await createBill(alice);
    await Bill.updateOne({ _id: id }, { status: 'complete', findings: [{ id: 'f-1', category: 'billing_error', amount: 10 }] });

    const attempts = [
      bob.get(`/bills/${id}`),
      bob.post(`/bills/${id}/uploaded`),
      bob.put(`/bills/${id}/review`).send({ admissionAnswer: 'unsure', lineItems: [] }),
      bob.post(`/bills/${id}/letter`),
      bob.put(`/bills/${id}/letter`).send({ text: 'hijacked' }),
      bob.delete(`/bills/${id}`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    // Nothing Bob tried changed Alice's bill.
    const bill = await Bill.findById(id).lean();
    expect(bill).not.toBeNull();
    expect(bill!.status).toBe('complete');
    expect(bill!.letter?.text).toBeUndefined();
  });

  it("lists only the signed-in user's bills", async () => {
    const alice = await signedInAgent('alice@example.com');
    const bob = await signedInAgent('bob@example.com');
    await createBill(alice);
    await createBill(alice);
    await createBill(bob);
    expect((await alice.get('/bills')).body).toHaveLength(2);
    expect((await bob.get('/bills')).body).toHaveLength(1);
  });

  it('treats a malformed bill ID as not found instead of a server error', async () => {
    const alice = await signedInAgent('alice@example.com');
    expect((await alice.get('/bills/not-an-id')).status).toBe(404);
  });
});
