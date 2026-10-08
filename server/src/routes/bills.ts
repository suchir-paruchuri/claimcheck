import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/auth';
import { enqueue, JOBS } from '../jobs/queue';
import { Bill } from '../models/Bill';
import { classifyBill } from '../rules/classify';
import { deleteFile, presignUpload } from '../services/storage';

export const billsRouter = Router();

const userId = (req: Request) => (req as AuthedRequest).user.id;

/**
 * Ownership check: the bill ID and the signed-in user's ID are matched in the same query,
 * so requesting someone else's bill ID behaves exactly like a bill that doesn't exist.
 */
function findOwnedBill(req: Request) {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) return null;
  return Bill.findOne({ _id: id, userId: userId(req) });
}

billsRouter.get('/', async (req, res) => {
  const bills = await Bill.find({ userId: userId(req) })
    .select('status billType originalFilename providerName totals letter.status fileDeleted createdAt')
    .sort({ createdAt: -1 })
    .lean();
  res.json(bills);
});

// Step 1: create the bill and hand the browser a presigned S3 URL for the PDF.
billsRouter.post('/', async (req, res) => {
  const parsed = z.object({ filename: z.string().max(200).regex(/\.pdf$/i, 'Only PDF bills are supported') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const fileKey = `uploads/${userId(req)}/${randomUUID()}.pdf`;
  const bill = await Bill.create({ userId: userId(req), fileKey, originalFilename: parsed.data.filename });
  res.status(201).json({ id: bill.id, uploadUrl: await presignUpload(fileKey) });
});

// Step 2: the browser finished uploading, so queue extraction.
billsRouter.post('/:id/uploaded', async (req, res) => {
  const bill = await findOwnedBill(req);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'pending' && bill.status !== 'failed') return res.status(409).json({ error: `Bill is already ${bill.status}` });
  await enqueue(JOBS.extract, bill.id);
  res.status(202).json({ status: 'queued' });
});

// Polled by the frontend for status, line items, findings, and the letter.
billsRouter.get('/:id', async (req, res) => {
  const bill = await findOwnedBill(req)?.lean();
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const { fileKey: _private, ...rest } = bill;
  res.json(rest);
});

const reviewSchema = z.object({
  admissionAnswer: z.enum(['admitted', 'not_admitted', 'unsure']),
  lineItems: z.array(
    z.object({
      id: z.string(),
      code: z.string().min(1).max(10),
      description: z.string().max(300),
      modifiers: z.array(z.string().max(4)).max(4),
      units: z.number().positive(),
      charge: z.number().nonnegative(),
      dateOfService: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notReceived: z.boolean(),
    }),
  ),
  billTypeOverride: z.enum(['physician', 'outpatient', 'inpatient']).optional(),
});

// Step 3: the patient confirms or corrects line items, then analysis is queued.
billsRouter.put('/:id/review', async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const bill = await findOwnedBill(req);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'awaiting_review' && bill.status !== 'complete') return res.status(409).json({ error: `Bill is ${bill.status}` });

  const edits = new Map(parsed.data.lineItems.map((li) => [li.id, li]));
  for (const li of bill.lineItems) {
    const edit = edits.get(li.id);
    if (!edit) continue;
    const corrected = edit.code !== li.code || edit.units !== li.units || edit.charge !== li.charge || edit.dateOfService !== li.dateOfService;
    li.set({ ...edit, ...(corrected ? { extractionStatus: 'verified', reviewReasons: ['Corrected by patient'] } : {}) });
  }

  const classification = classifyBill({
    revenueCodes: bill.lineItems.flatMap((li) => (li.revenueCode ? [li.revenueCode] : [])),
    typeOfBill: bill.typeOfBill ?? undefined,
    admissionDate: bill.admissionDate ?? undefined,
    dischargeDate: bill.dischargeDate ?? undefined,
    answer: parsed.data.admissionAnswer,
  });
  bill.admissionAnswer = parsed.data.admissionAnswer;
  bill.billType = parsed.data.billTypeOverride ?? classification.billType;
  bill.classificationReasons = parsed.data.billTypeOverride ? ['Bill type chosen by patient'] : classification.reasons;
  bill.status = 'analyzing';
  await bill.save();
  await enqueue(JOBS.analyze, bill.id);
  res.status(202).json({ billType: bill.billType, reasons: bill.classificationReasons });
});

billsRouter.post('/:id/letter', async (req, res) => {
  const bill = await findOwnedBill(req);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'complete') return res.status(409).json({ error: 'The audit has not finished yet' });
  if (!bill.findings.some((f) => f.category !== 'info')) return res.status(409).json({ error: 'There are no findings to dispute' });
  bill.set('letter', { status: 'drafting' });
  await bill.save();
  await enqueue(JOBS.letter, bill.id);
  res.status(202).json({ status: 'drafting' });
});

billsRouter.put('/:id/letter', async (req, res) => {
  const parsed = z.object({ text: z.string().min(1).max(20_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Letter text is required' });
  const bill = await findOwnedBill(req);
  if (!bill?.letter?.text) return res.status(404).json({ error: 'Letter not found' });
  bill.set('letter.text', parsed.data.text);
  await bill.save();
  res.json({ ok: true });
});

billsRouter.delete('/:id', async (req, res) => {
  const bill = await findOwnedBill(req);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (!bill.fileDeleted) await deleteFile(bill.fileKey).catch(() => undefined);
  await bill.deleteOne();
  res.status(204).end();
});
