import bcrypt from 'bcrypt';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Bill } from '../../src/models/Bill';
import { User } from '../../src/models/User';
import { deleteFile } from '../../src/services/storage';
import { clearTestDb, connectTestDb, disconnectTestDb } from './db';

jest.mock('../../src/services/storage', () => ({
  presignUpload: jest.fn(async () => 'https://s3.test/presigned-upload'),
  deleteFile: jest.fn(async () => undefined),
}));
jest.mock('../../src/jobs/queue', () => ({
  ...jest.requireActual('../../src/jobs/queue'),
  enqueue: jest.fn(async () => undefined),
}));

const PASSWORD = 'correct-horse-battery';
const app = createApp();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
  process.env.AUTH_RATE_LIMIT = '1000';
  await connectTestDb();
}, 60_000);
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});
afterAll(disconnectTestDb);

async function signedInAgent(email = 'pat@example.com', name = 'Pat Lee') {
  const agent = request.agent(app);
  expect((await agent.post('/auth/signup').send({ name, email, password: PASSWORD })).status).toBe(201);
  return agent;
}

/** A second, independent session for the same account (another device). */
async function secondSession(email = 'pat@example.com') {
  const agent = request.agent(app);
  expect((await agent.post('/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

describe('account info', () => {
  it('returns the name, email, and sign-up date, never the password hash', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/auth/me');
    expect(res.body).toMatchObject({ name: 'Pat Lee', email: 'pat@example.com' });
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.passwordHash).toBeUndefined();
  });
});

describe('changing the name', () => {
  it('updates the name', async () => {
    const agent = await signedInAgent();
    const res = await agent.patch('/account/name').send({ name: '  Pat Rivera  ' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Pat Rivera');
    expect((await agent.get('/auth/me')).body.name).toBe('Pat Rivera');
  });

  it('rejects an empty name', async () => {
    const agent = await signedInAgent();
    expect((await agent.patch('/account/name').send({ name: '   ' })).status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await request(app).patch('/account/name').send({ name: 'Mallory' })).status).toBe(401);
  });
});

describe('changing the email', () => {
  it('requires the current password', async () => {
    const agent = await signedInAgent();
    const res = await agent.patch('/account/email').send({ email: 'new@example.com', currentPassword: 'wrong-password-1' });
    expect(res.status).toBe(403);
    expect((await User.findOne({ email: 'pat@example.com' }))).not.toBeNull();
  });

  it('changes the email, keeps the session working, and lets you sign in with the new email', async () => {
    const agent = await signedInAgent();
    const res = await agent.patch('/account/email').send({ email: 'New@Example.com', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new@example.com');
    expect((await agent.get('/auth/me')).body.email).toBe('new@example.com');
    expect((await request(app).post('/auth/login').send({ email: 'new@example.com', password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/auth/login').send({ email: 'pat@example.com', password: PASSWORD })).status).toBe(401);
  });

  it("won't take an email another account uses", async () => {
    await signedInAgent('taken@example.com', 'Other');
    const agent = await signedInAgent();
    const res = await agent.patch('/account/email').send({ email: 'taken@example.com', currentPassword: PASSWORD });
    expect(res.status).toBe(409);
  });
});

describe('changing the password', () => {
  it('requires the current password', async () => {
    const agent = await signedInAgent();
    const res = await agent.patch('/account/password').send({ currentPassword: 'wrong-password-1', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(403);
  });

  it('enforces the minimum length', async () => {
    const agent = await signedInAgent();
    expect((await agent.patch('/account/password').send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
  });

  it('switches to the new password, keeps this session, and signs out other devices', async () => {
    const agent = await signedInAgent();
    const otherDevice = await secondSession();
    expect((await otherDevice.get('/bills')).status).toBe(200);

    const res = await agent.patch('/account/password').send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);

    expect((await agent.get('/bills')).status).toBe(200); // this session was refreshed
    expect((await otherDevice.get('/bills')).status).toBe(401); // the old session no longer works
    expect((await request(app).post('/auth/login').send({ email: 'pat@example.com', password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/auth/login').send({ email: 'pat@example.com', password: 'a-brand-new-password' })).status).toBe(200);

    const user = await User.findOne({ email: 'pat@example.com' }).lean();
    expect(await bcrypt.compare('a-brand-new-password', user!.passwordHash)).toBe(true);
  });
});

describe('deleting the account', () => {
  it('requires the current password and keeps everything if it is wrong', async () => {
    const agent = await signedInAgent();
    await agent.post('/bills').send({ filename: 'bill.pdf' });
    const res = await agent.delete('/account').send({ currentPassword: 'wrong-password-1' });
    expect(res.status).toBe(403);
    expect(await User.countDocuments()).toBe(1);
    expect(await Bill.countDocuments()).toBe(1);
  });

  it("removes the account, the user's bills and files, and ends every session, without touching other users", async () => {
    const agent = await signedInAgent();
    const otherDevice = await secondSession();
    const bob = await signedInAgent('bob@example.com', 'Bob');
    await agent.post('/bills').send({ filename: 'one.pdf' });
    await agent.post('/bills').send({ filename: 'two.pdf' });
    await bob.post('/bills').send({ filename: 'bobs.pdf' });

    const res = await agent.delete('/account').send({ currentPassword: PASSWORD });
    expect(res.status).toBe(204);

    expect(await User.exists({ email: 'pat@example.com' })).toBeNull();
    expect(await Bill.countDocuments()).toBe(1); // only Bob's bill is left
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect((await agent.get('/auth/me')).status).toBe(401);
    expect((await otherDevice.get('/bills')).status).toBe(401); // a still-unexpired token for a deleted account is rejected
    expect((await bob.get('/bills')).body).toHaveLength(1);
  });
});
