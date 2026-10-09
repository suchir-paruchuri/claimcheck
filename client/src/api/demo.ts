// Demo mode (VITE_DEMO=1): an in-memory stand-in for the API so the frontend can be
// shown without a backend. The sample bill and findings are synthetic, but the rates and
// rules match the real 2026 CMS data the server uses.
import type { Api, Bill, Finding, LineItem, User } from './types';
import demoAudit from './demoAudit.json';
import demoEob from './demoEob.json';
import { DEMO_SECTIONS, fallbackSection } from './demoLetter';

const user: User = { id: 'demo', email: 'demo@claimcheck.app', name: 'Jordan Rivera', createdAt: new Date().toISOString() };
const DEMO_PASSWORD = 'demo-password';
export const SAMPLE_BILL_URL = '/samples/sample-itemized-bill.pdf';
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
  const codeOf = new Map(b.lineItems.map((l) => [l.id, l.code]));
  const findings = (demoAudit.findings as unknown as Finding[]).filter((f) => {
    if (f.checkId === 'pricing' && skip.has(f.lineItemIds[0])) return false;
    // The sample findings are for the codes on the bill. If the visitor leaves a misread code
    // uncorrected (81008 instead of 81003), that line's findings no longer apply.
    const code = (f.evidence as { code?: string }).code;
    return !code || f.lineItemIds.every((id) => codeOf.get(id) === code);
  });
  notReceived.forEach((li, i) =>
    findings.push({
      id: `not_received-${i + 1}`, checkId: 'not_received', category: 'billing_error', lineItemIds: [li.id], amount: li.charge,
      message: `Marked as not received: "${li.description}" (code ${li.code}) on ${li.dateOfService}, billed at $${li.charge.toFixed(2)}.`,
      evidence: { code: li.code, reportedBy: 'patient' },
    }),
  );
  return findings;
}

/** Line findings plus, once a statement has been read, the insurance comparison (also from the real engine). */
function analyze(b: Bill) {
  if (b.letter?.status === 'ready') b.letter.stale = true;
  const hasEob = !!b.eobs?.some((e) => e.status === 'ready');
  b.findings = [...auditFindings(b), ...(hasEob ? (demoEob.findings as unknown as Finding[]) : [])];
  b.reconciliation = hasEob ? (demoEob.reconciliation as Bill['reconciliation']) : undefined;
  b.checksRun = hasEob ? [...demoAudit.checksRun, 'insurance'] : demoAudit.checksRun;
  const sum = (c: string) =>
    Math.round(b.findings.filter((f) => f.category === c && f.checkId !== 'insurance_balance').reduce((s, f) => s + f.amount, 0) * 100) / 100;
  b.totals = {
    billed: b.lineItems.reduce((s, l) => s + l.charge, 0),
    billingErrors: sum('billing_error'),
    pricingConcerns: sum('pricing_concern'),
    insuranceIssues: sum('insurance_issue'),
  };
}

/** Same template as the server's buildLetter, filled with the demo's validated sections. */
function demoLetterText(b: Bill): string {
  const findings = b.findings.filter((f) => f.category !== 'info');
  const text = (f: Finding) => DEMO_SECTIONS[f.id] ?? fallbackSection(f);
  const lines = [
    new Date().toLocaleDateString('en-US', { dateStyle: 'long' }), '',
    `To the billing department of ${b.providerName}:`, '',
    `I am writing to dispute charges on my itemized bill (account ${b.accountNumber}). I reviewed each line item and identified the following issues.`,
  ];
  const groups: [Finding['category'], string][] = [
    ['billing_error', 'Billing errors to correct:'],
    ['pricing_concern', 'Charges I am asking you to justify or reduce:'],
    ['insurance_issue', 'Charges to reconcile with my insurance:'],
  ];
  for (const [category, heading] of groups) {
    const group = findings.filter((f) => f.category === category);
    if (group.length) lines.push('', heading, ...group.map((f, i) => `${i + 1}. ${text(f)}`));
  }
  lines.push('', 'Please send a corrected itemized bill, and place my account on hold while these items are reviewed.', '', 'Sincerely,', user.name);
  return lines.join('\n');
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
  async updateName(name) { await wait(250); user.name = name.trim(); return { ...user }; },
  async changeEmail(email, currentPassword) {
    await wait(250);
    if (currentPassword !== DEMO_PASSWORD) throw new Error('Your current password is incorrect');
    user.email = email.trim().toLowerCase();
    return { ...user };
  },
  async changePassword(currentPassword) {
    await wait(250);
    if (currentPassword !== DEMO_PASSWORD) throw new Error('Your current password is incorrect');
    return { ...user };
  },
  async deleteAccount(currentPassword) {
    await wait(300);
    if (currentPassword !== DEMO_PASSWORD) throw new Error('Your current password is incorrect');
    bills.clear();
    signedIn = false;
  },
  async listBills() { await wait(200); return [...bills.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },

  async uploadBill(file) {
    await wait(600);
    const id = `bill-${bills.size + 1}`;
    // The sample bill waits on the Upload step until the visitor clicks Next (startExtraction).
    bills.set(id, {
      _id: id, status: 'pending', originalFilename: file.name,
      createdAt: new Date().toISOString(), lineItems: [], findings: [], letter: { status: 'none' },
    });
    return id;
  },

  async startExtraction(id) {
    await wait(300);
    const b = bills.get(id)!;
    b.status = 'extracting';
    advance(id, 'awaiting_review', 3500, (bill) => {
      bill.providerName = 'Lakeshore Family Medicine';
      bill.accountNumber = '48213-07';
      bill.lineItems = sampleLines();
      bill.statedTotal = 1031;
      bill.amountDue = 612;
      bill.totalsReconcile = true;
      bill.suggestedBillType = 'physician';
    });
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
      analyze(bill);
      bill.checksSkipped = [{ checkId: 'outside_stay', reason: 'Only applies to hospital stays with admission and discharge dates.' }];
      bill.benchmarkMultiplier = 3;
    });
  },

  async requestLetter(id) {
    const b = bills.get(id)!;
    b.letter = { status: 'drafting' };
    setTimeout(() => {
      b.letter = { status: 'ready', generatedAt: new Date().toISOString(), text: demoLetterText(b) };
    }, 2200);
  },
  async saveLetter(id, text) { const b = bills.get(id)!; b.letter = { ...b.letter!, text }; },
  async deleteBill(id) { bills.delete(id); },
  async renameBill(id, name) { await wait(200); const b = bills.get(id)!; b.displayName = name.trim() || undefined; },

  async uploadEob(billId, file) {
    await wait(600);
    const b = bills.get(billId)!;
    const id = `eob-demo${(b.eobs?.length ?? 0) + 1}`;
    b.eobs = [...(b.eobs ?? []), { id, originalFilename: file.name, status: 'extracting', lines: [] }];
    setTimeout(() => {
      const eob = b.eobs?.find((e) => e.id === id);
      if (!eob) return;
      Object.assign(eob, {
        status: 'ready',
        payer: demoEob.eob.payer,
        claimNumber: demoEob.eob.claimNumber,
        lines: demoEob.eob.lines.map((l) => ({ ...l, id: `${id}-${l.id.split('-').pop()}`, eobId: id, foundInDocument: true })),
      });
      if (b.status === 'complete') {
        b.status = 'analyzing';
        advance(billId, 'complete', 1500, analyze);
      }
    }, 2500);
  },
  async retryEob() {},
  async deleteEob(billId, eobId) {
    const b = bills.get(billId)!;
    b.eobs = b.eobs?.filter((e) => e.id !== eobId);
    if (b.status === 'complete') analyze(b);
  },
};
