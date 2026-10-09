import { Schema, model, Types, type InferSchemaType } from 'mongoose';

export const BILL_STATUSES = [
  'pending', 'extracting', 'awaiting_review', 'analyzing', 'complete', 'failed',
] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

const lineItemSchema = new Schema(
  {
    id: { type: String, required: true },
    code: { type: String, required: true },
    description: { type: String, default: '' },
    revenueCode: String,
    modifiers: { type: [String], default: [] },
    units: { type: Number, default: 1 },
    unitPrice: Number,
    charge: { type: Number, required: true },
    dateOfService: { type: String, required: true },
    placeOfService: String,
    notReceived: { type: Boolean, default: false },
    extractionStatus: { type: String, enum: ['verified', 'needs_review', 'unverified'], default: 'needs_review' },
    verification: {
      foundInDocument: Boolean,
      cmsMatch: Boolean,
      descriptionMatch: Boolean,
    },
    reviewReasons: { type: [String], default: [] },
    // Location comes from the PDF text layer, never from the LLM.
    source: { page: Number, text: String },
  },
  { _id: false },
);

const findingSchema = new Schema(
  {
    id: String,
    checkId: String,
    category: { type: String, enum: ['billing_error', 'pricing_concern', 'insurance_issue', 'info'] },
    lineItemIds: [String],
    amount: Number,
    message: String,
    evidence: Schema.Types.Mixed,
  },
  { _id: false },
);

const eobLineSchema = new Schema(
  {
    id: { type: String, required: true },
    eobId: { type: String, required: true },
    dateOfService: { type: String, required: true },
    code: String,
    description: { type: String, default: '' },
    billed: { type: Number, required: true },
    allowed: Number,
    planPaid: Number,
    patientResponsibility: { type: Number, required: true },
    foundInDocument: Boolean,
  },
  { _id: false },
);

/** An insurance statement (Explanation of Benefits) the patient added to this bill. */
const eobSchema = new Schema(
  {
    id: { type: String, required: true },
    fileKey: { type: String, required: true },
    originalFilename: String,
    status: { type: String, enum: ['pending', 'extracting', 'ready', 'failed'], default: 'pending' },
    payer: String,
    claimNumber: String,
    lines: { type: [eobLineSchema], default: [] },
    // The Gemini model that read this statement.
    model: String,
    // When every Gemini model was busy: the time of the next automatic attempt.
    retryAt: Date,
    error: String,
  },
  { _id: false },
);

const billSchema = new Schema(
  {
    // Every query on bills filters by userId, so one user can never read another's bill.
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: BILL_STATUSES, default: 'pending' },
    fileKey: { type: String, required: true },
    fileDeleted: { type: Boolean, default: false },
    originalFilename: String,
    // A name the patient chose for this bill; shown instead of the provider name or filename.
    displayName: String,
    providerName: String,
    accountNumber: String,
    payer: String,

    billType: { type: String, enum: ['physician', 'outpatient', 'inpatient', 'uncertain'] },
    suggestedBillType: String,
    classificationReasons: [String],
    admissionAnswer: { type: String, enum: ['admitted', 'not_admitted', 'unsure'] },
    typeOfBill: String,
    admissionDate: String,
    dischargeDate: String,
    statedTotal: Number,
    amountDue: Number,
    totalsReconcile: Boolean,

    lineItems: { type: [lineItemSchema], default: [] },
    findings: { type: [findingSchema], default: [] },
    eobs: { type: [eobSchema], default: [] },
    reconciliation: {
      matches: [{ _id: false, eobLineId: String, billLineIds: [String], how: String }],
      unmatchedBillLineIds: [String],
      unmatchedEobLineIds: [String],
      patientResponsibility: Number,
      maxExpectedDue: Number,
    },
    checksRun: [String],
    checksSkipped: [{ _id: false, checkId: String, reason: String }],
    benchmarkMultiplier: Number,
    totals: { billed: Number, billingErrors: Number, pricingConcerns: Number, insuranceIssues: Number },

    letter: {
      text: String,
      generatedAt: Date,
      status: { type: String, enum: ['none', 'drafting', 'ready', 'failed'], default: 'none' },
      // Set when the findings change after the letter was drafted (an insurance statement added, say).
      stale: Boolean,
    },
    error: String,
    timings: { extractionMs: Number, analysisMs: Number, letterMs: Number },
    // When every Gemini model was busy: the time of the next automatic attempt, per step.
    retryAt: { extract: Date, letter: Date },
    // Which Gemini model handled each step (the first in GEMINI_MODELS that answered).
    models: { extraction: String, letter: String },
  },
  { timestamps: true, versionKey: false },
);

billSchema.index({ userId: 1, createdAt: -1 });

export type BillDoc = InferSchemaType<typeof billSchema>;
export const Bill = model('Bill', billSchema);
