import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { User } from '../models/User';

export const BCRYPT_COST = 12;
const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

type SessionUser = { id: string; email: string; sessionVersion?: number | null };

/**
 * Issues the session JWT in an httpOnly cookie. The token carries the user's session version;
 * bumping that version (on a password change) invalidates every older token at once.
 */
export function issueSession(res: Response, user: SessionUser) {
  const token = jwt.sign({ sub: user.id, email: user.email, sv: user.sessionVersion ?? 0 }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
  });
  // httpOnly: page scripts can't read the token. sameSite + secure limit where it's sent.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? 'none' : 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE);
}

/**
 * Verifies the JWT on every protected request, then confirms the account still exists and the
 * token's session version is current, so deleted accounts and sessions from before a password
 * change are rejected even though their tokens haven't expired.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
  try {
    const user = await User.findById(payload.sub).select('email sessionVersion').lean();
    if (!user || (user.sessionVersion ?? 0) !== (payload.sv ?? 0)) return res.status(401).json({ error: 'Session expired' });
    (req as AuthedRequest).user = { id: String(user._id), email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(128, 'Password must be at most 128 characters');
export const nameSchema = z.string().trim().min(1, 'Enter your name').max(100, 'Name must be at most 100 characters');

// Slows down password guessing: 10 attempts per IP per 15 minutes by default. The limit is read
// per request so tests can raise or lower it. In-memory store is fine for a single server.
export const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicUser = (u: { id: string; email: string; name: string; createdAt?: Date | null }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.createdAt,
});

export const authRouter = Router();

authRouter.post('/signup', passwordLimiter, async (req, res) => {
  const parsed = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password, name } = parsed.data;

  if (await User.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists' });
  const user = await User.create({ email, name, passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
  issueSession(res, user);
  res.status(201).json(publicUser(user));
});

authRouter.post('/login', passwordLimiter, async (req, res) => {
  const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).safeParse(req.body);
  // Same message for a wrong email and a wrong password, so accounts can't be enumerated.
  const invalid = () => res.status(401).json({ error: 'Invalid email or password' });
  if (!parsed.success) return invalid();

  const user = await User.findOne({ email: parsed.data.email });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return invalid();
  issueSession(res, user);
  res.json(publicUser(user));
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById((req as AuthedRequest).user.id);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json(publicUser(user));
});
