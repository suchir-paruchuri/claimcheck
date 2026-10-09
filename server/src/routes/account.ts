import bcrypt from 'bcrypt';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  BCRYPT_COST, clearSession, emailSchema, issueSession, nameSchema, passwordLimiter, passwordSchema, publicUser,
  type AuthedRequest,
} from '../auth/auth';
import { Bill } from '../models/Bill';
import { User } from '../models/User';
import { deleteFile } from '../services/storage';

export const accountRouter = Router();

const userId = (req: Request) => (req as AuthedRequest).user.id;
const currentPassword = z.string().min(1, 'Enter your current password').max(128);

/** Loads the signed-in user and checks their current password; sensitive changes require it. */
async function verifyPassword(req: Request, password: string) {
  const user = await User.findById(userId(req));
  if (!user) return { error: 401 as const };
  if (!(await bcrypt.compare(password, user.passwordHash))) return { error: 403 as const };
  return { user };
}

const wrongPassword = { error: 'Your current password is incorrect' };

// Changing the display name is low-risk, so it doesn't ask for the password.
accountRouter.patch('/name', async (req, res) => {
  const parsed = z.object({ name: nameSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const user = await User.findByIdAndUpdate(userId(req), { name: parsed.data.name }, { new: true });
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json(publicUser(user));
});

accountRouter.patch('/email', passwordLimiter, async (req, res) => {
  const parsed = z.object({ email: emailSchema, currentPassword }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const check = await verifyPassword(req, parsed.data.currentPassword);
  if (check.error === 401) return res.status(401).json({ error: 'Not signed in' });
  if (check.error === 403) return res.status(403).json(wrongPassword);
  const { user } = check;

  if (parsed.data.email === user.email) return res.json(publicUser(user));
  if (await User.exists({ email: parsed.data.email, _id: { $ne: user._id } })) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  user.email = parsed.data.email;
  await user.save();
  issueSession(res, user); // the session token carries the email, so refresh it
  res.json(publicUser(user));
});

accountRouter.patch('/password', passwordLimiter, async (req, res) => {
  const parsed = z.object({ currentPassword, newPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const check = await verifyPassword(req, parsed.data.currentPassword);
  if (check.error === 401) return res.status(401).json({ error: 'Not signed in' });
  if (check.error === 403) return res.status(403).json(wrongPassword);
  const { user } = check;

  user.passwordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST);
  // Bumping the session version signs out every other device; this one gets a fresh session.
  user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  await user.save();
  issueSession(res, user);
  res.json(publicUser(user));
});

/** Permanently deletes the account, every bill and its results, and the uploaded files. */
accountRouter.delete('/', passwordLimiter, async (req, res) => {
  const parsed = z.object({ currentPassword }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const check = await verifyPassword(req, parsed.data.currentPassword);
  if (check.error === 401) return res.status(401).json({ error: 'Not signed in' });
  if (check.error === 403) return res.status(403).json(wrongPassword);
  const { user } = check;

  const bills = await Bill.find({ userId: user._id }).select('fileKey fileDeleted').lean();
  // File deletion is best-effort: the bucket's 30-day lifecycle rule removes anything missed.
  await Promise.all(bills.filter((b) => !b.fileDeleted).map((b) => deleteFile(b.fileKey).catch(() => undefined)));
  await Bill.deleteMany({ userId: user._id });
  await user.deleteOne();
  clearSession(res);
  res.status(204).end();
});
