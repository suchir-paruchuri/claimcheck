// Mirrors the server's API responses.

export type BillStatus = 'pending' | 'extracting' | 'awaiting_review' | 'analyzing' | 'complete' | 'failed';
export type BillType = 'physician' | 'outpatient' | 'inpatient' | 'uncertain';
export type AdmissionAnswer = 'admitted' | 'not_admitted' | 'unsure';
export type ExtractionStatus = 'verified' | 'needs_review' | 'unverified';
export type FindingCategory = 'billing_error' | 'pricing_concern' | 'insurance_issue' | 'info';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt?: string;
}

export interface LineItem {
  id: string;
  code: string;
  description: string;
  revenueCode?: string;
  modifiers: string[];
  units: number;
  charge: number;
  dateOfService: string;
  placeOfService?: string;
  notReceived: boolean;
  extractionStatus: ExtractionStatus;
  verification?: { foundInDocument: boolean; cmsMatch: boolean; descriptionMatch: boolean };
  reviewReasons: string[];
  source?: { page: number; text: string };
}

export interface Finding {
  id: string;
  checkId: string;
  category: FindingCategory;
  lineItemIds: string[];
  amount: number;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

export interface BillSummary {
  _id: string;
  status: BillStatus;
  billType?: BillType;
  displayName?: string;
  originalFilename?: string;
  providerName?: string;
  totals?: { billed: number; billingErrors: number; pricingConcerns: number; insuranceIssues?: number };
  letter?: { status: 'none' | 'drafting' | 'ready' | 'failed' };
  fileDeleted?: boolean;
  createdAt: string;
}

export interface EobLine {
  id: string;
  eobId: string;
  dateOfService: string;
  code?: string;
  description: string;
  billed: number;
  allowed?: number;
  planPaid?: number;
  patientResponsibility: number;
  foundInDocument?: boolean;
}

export interface Eob {
  id: string;
  originalFilename?: string;
  status: 'pending' | 'extracting' | 'ready' | 'failed';
  payer?: string;
  claimNumber?: string;
  lines: EobLine[];
  error?: string;
}

export interface Reconciliation {
  matches: { eobLineId: string; billLineIds: string[]; how: 'code' | 'amount' | 'description' | 'grouped' }[];
  unmatchedBillLineIds: string[];
  unmatchedEobLineIds: string[];
  patientResponsibility: number;
  maxExpectedDue: number;
}

export interface Bill extends BillSummary {
  accountNumber?: string;
  suggestedBillType?: BillType;
  billType?: BillType;
  classificationReasons?: string[];
  admissionAnswer?: AdmissionAnswer;
  admissionDate?: string;
  dischargeDate?: string;
  statedTotal?: number;
  amountDue?: number;
  totalsReconcile?: boolean;
  eobs?: Eob[];
  reconciliation?: Reconciliation;
  lineItems: LineItem[];
  findings: Finding[];
  checksRun?: string[];
  checksSkipped?: { checkId: string; reason: string }[];
  benchmarkMultiplier?: number;
  letter?: { status: 'none' | 'drafting' | 'ready' | 'failed'; text?: string; generatedAt?: string; stale?: boolean };
  error?: string;
}

export interface ReviewPayload {
  admissionAnswer: AdmissionAnswer;
  billTypeOverride?: Exclude<BillType, 'uncertain'>;
  lineItems: Pick<LineItem, 'id' | 'code' | 'description' | 'modifiers' | 'units' | 'charge' | 'dateOfService' | 'notReceived'>[];
}

export interface Api {
  me(): Promise<User | null>;
  login(email: string, password: string): Promise<User>;
  signup(name: string, email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  updateName(name: string): Promise<User>;
  changeEmail(email: string, currentPassword: string): Promise<User>;
  changePassword(currentPassword: string, newPassword: string): Promise<User>;
  deleteAccount(currentPassword: string): Promise<void>;
  listBills(): Promise<BillSummary[]>;
  uploadBill(file: File): Promise<string>;
  getBill(id: string): Promise<Bill>;
  retryBill(id: string): Promise<void>;
  /** Starts reading a bill whose file is uploaded (the demo waits for the patient to click Next). */
  startExtraction(id: string): Promise<void>;
  submitReview(id: string, payload: ReviewPayload): Promise<void>;
  requestLetter(id: string): Promise<void>;
  saveLetter(id: string, text: string): Promise<void>;
  deleteBill(id: string): Promise<void>;
  renameBill(id: string, name: string): Promise<void>;
  uploadEob(billId: string, file: File): Promise<void>;
  retryEob(billId: string, eobId: string): Promise<void>;
  deleteEob(billId: string, eobId: string): Promise<void>;
}
