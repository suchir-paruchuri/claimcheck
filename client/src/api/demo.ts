// Demo mode (VITE_DEMO=1): an in-memory stand-in for the API so the frontend can be
// shown without a backend. The sample bill and findings are synthetic, but the rates and
// rules match the real 2026 CMS data the server uses.
import type { Api, Bill, Finding, LineItem, User } from './types';
import demoAudit from './demoAudit.json';

const user: User = { id: 'demo', email: 'demo@claimcheck.app', name: 'Jordan Rivera' };
let signedIn = false;
const bills = new Map<string, Bill>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const line = (id: string, code: string, description: string, charge: number, extra: Partial<LineItem> = {}): LineItem => ({
  id, code, description, modifiers: [], units: 1, charge, dateOfService: '2026-09-14', placeOfService: '11',
  notReceived: false, extractionStatus: 'verified', reviewReasons: [],
  verification: { foundInDocument: true, cmsMatch: true, descriptionMatch: true }, ...extra,
});

function sampleLines(): LineItem[] {
  return [
    line('li-1', '99214', 'Office visit, established patient, moderate', 410),
    line('li-2', '80053', 'Comprehensive metabolic panel', 186),
    line('li-3', '82947', 'Glucose, quantitative, blood', 48),
    line('li-4', '85025', 'CBC with automated differential', 64),
    line('li-5', '85025', 'CBC with automated differential', 64),
    line('li-6', '36415', 'Routine venipuncture', 75, { units: 3 }),
    line('li-7', '81003', 'Urinalysis, automated', 39, {
      code: '81008', extractionStatus: 'needs_review',
      verification: { foundInDocument: false, cmsMatch: false, descriptionMatch: false },
      reviewReasons: ['Code 81008 was not found on the bill as extracted.'],
    }),
    line('li-8', '93000', 'Electrocardiogram, complete', 145),
  ];
}

/**
 * Findings for the sample bill, produced by running the server's real rules engine on these
 * lines against the 2026 CMS fee schedules, NCCI edits, and MUE limits (see demoAudit.json).
 */
function auditFindings(b: Bill): Finding[] {
  const notReceived = b.lineItems.filter((l) => l.notReceived);
  const skip = new Set(notReceived.map((l) => l.id));
  const findings = (demoAudit.findings as unknown as Finding[]).filter((f) => !(f.checkId === 'pricing' && skip.has(f.lineItemIds[0])));
  notReceived.forEach((li, i) =>
    findings.push({
      id: `not_received-${i + 1}`, checkId: 'not_received', category: 'billing_error', lineItemIds: [li.id], amount: li.charge,
      message: `Marked as not received: "${li.description}" (code ${li.code}) on ${li.dateOfService}, billed at $${li.charge.toFixed(2)}.`,
      evidence: { code: li.code, reportedBy: 'patient' },
    }),
  );
  return findings;
}

function totals(b: Bill) {
  const sum = (c: string) => Math.round(b.findings.filter((f) => f.category === c).reduce((s, f) => s + f.amount, 0) * 100) / 100;
  return { billed: b.lineItems.reduce((s, l) => s + l.charge, 0), billingErrors: sum('billing_error'), pricingConcerns: sum('pricing_concern') };
}

function advance(id: string, status: Bill['status'], ms: number, then?: (b: Bill) => void) {
  setTimeout(() => {
    const b = bills.get(id);
    if (!b) return;
    b.status = status;
    then?.(b);
  }, ms);
}

export const demoApi: Api = {
  async me() { await wait(150); return signedIn ? user : null; },
  async login() { await wait(300); signedIn = true; return user; },
  async signup(name) { await wait(300); signedIn = true; user.name = name || user.name; return user; },
  async logout() { signedIn = false; },
  async listBills() { await wait(200); return [...bills.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },

  async uploadBill(file) {
    await wait(600);
    const id = `bill-${bills.size + 1}`;
    bills.set(id, {
      _id: id, status: 'extracting', originalFilename: file.name, providerName: 'Lakeshore Family Medicine', accountNumber: '48213-07',
      createdAt: new Date().toISOString(), lineItems: [], findings: [], letter: { status: 'none' },
    });
    advance(id, 'awaiting_review', 3500, (b) => {
      b.lineItems = sampleLines();
      b.statedTotal = 1031;
      b.totalsReconcile = true;
      b.suggestedBillType = 'physician';
    });
    return id;
  },

  async getBill(id) {
    await wait(120);
    const b = bills.get(id);
    if (!b) throw new Error('Bill not found');
    return structuredClone(b);
  },
  async retryBill() {},

  async submitReview(id, payload) {
    await wait(300);
    const b = bills.get(id)!;
    const edits = new Map(payload.lineItems.map((l) => [l.id, l]));
    b.lineItems = b.lineItems.map((l) => {
      const e = edits.get(l.id);
      if (!e) return l;
      const corrected = e.code !== l.code;
      return { ...l, ...e, ...(corrected ? { extractionStatus: 'verified' as const, reviewReasons: ['Corrected by you'] } : {}) };
    });
    b.admissionAnswer = payload.admissionAnswer;
    b.billType = payload.billTypeOverride ?? 'physician';
    b.status = 'analyzing';
    advance(id, 'complete', 1800, (bill) => {
      bill.findings = auditFindings(bill);
      bill.checksRun = demoAudit.checksRun;
      bill.checksSkipped = [{ checkId: 'outside_stay', reason: 'Only applies to hospital stays with admission and discharge dates.' }];
      bill.benchmarkMultiplier = 3;
      bill.totals = totals(bill);
    });
  },

  async requestLetter(id) {
    const b = bills.get(id)!;
    b.letter = { status: 'drafting' };
    setTimeout(() => {
      const errors = b.findings.filter((f) => f.category === 'billing_error');
      const pricing = b.findings.filter((f) => f.category === 'pricing_concern');
      b.letter = {
        status: 'ready', generatedAt: new Date().toISOString(),
        text: [
          new Date().toLocaleDateString('en-US', { dateStyle: 'long' }), '',
          `To the billing department of ${b.providerName}:`, '',
          `I am writing to dispute charges on my itemized bill (account ${b.accountNumber}). I reviewed each line item and identified the following issues.`,
          '', 'Billing errors to correct:',
          ...errors.map((f, i) => `${i + 1}. ${f.message} Please correct or remove this charge.`),
          '', 'Charges I am asking you to justify or reduce:',
          ...pricing.map((f, i) => `${i + 1}. ${f.message} Please explain this charge or reduce it.`),
          '', 'Please send a corrected itemized bill, and place my account on hold while these items are reviewed.', '', 'Sincerely,', user.name,
        ].join('\n'),
      };
    }, 2200);
  },
  async saveLetter(id, text) { const b = bills.get(id)!; b.letter = { ...b.letter!, text }; },
  async deleteBill(id) { bills.delete(id); },
};
