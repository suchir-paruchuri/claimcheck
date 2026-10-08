import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { User } from '../models/User';

const BCRYPT_COST = 12;
const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

function issueSession(res: Response, user: { id: string; email: string }) {
  const token = jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: SESSION_TTL_SECONDS });
  // httpOnly: page scripts can't read the token. sameSite + secure limit where it's sent.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? 'none' : 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

/** Verifies the JWT on every protected request and attaches the user to it. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    (req as AuthedRequest).user = { id: String(payload.sub), email: String(payload.email) };
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
});

// Slows down password guessing. In-memory store is fine for a single server.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

export const authRouter = Router();

authRouter.post('/signup', loginLimiter, async (req, res) => {
  const parsed = credentials.extend({ name: z.string().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password, name } = parsed.data;

  if (await User.exists({ email: email.toLowerCase() })) return res.status(409).json({ error: 'An account with that email already exists' });
  const user = await User.create({ email, name, passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
  issueSession(res, { id: user.id, email: user.email });
  res.status(201).json({ id: user.id, email: user.email, name: user.name });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  // Same message for a wrong email and a wrong password, so accounts can't be enumerated.
  const invalid = () => res.status(401).json({ error: 'Invalid email or password' });
  if (!parsed.success) return invalid();

  const user = await User.findOne({ email: parsed.data.email.toLowerCase() });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return invalid();
  issueSession(res, { id: user.id, email: user.email });
  res.json({ id: user.id, email: user.email, name: user.name });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById((req as AuthedRequest).user.id).select('email name');
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ id: user.id, email: user.email, name: user.name });
});
