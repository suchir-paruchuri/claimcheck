// Core domain types shared by the rules engine, classifier, and API.
// These are plain data shapes so the engine stays pure and easy to test.

export type BillType = 'physician' | 'outpatient' | 'inpatient' | 'uncertain';
export type AdmissionAnswer = 'admitted' | 'not_admitted' | 'unsure';

export interface LineItem {
  id: string;
  code: string; // CPT/HCPCS code
  description: string;
  revenueCode?: string; // hospital bills only, e.g. "0450"
  modifiers: string[];
  units: number;
  unitPrice?: number;
  charge: number;
  dateOfService: string; // ISO date, YYYY-MM-DD
  placeOfService?: string; // two-digit POS code, physician bills
  notReceived?: boolean; // marked by the patient during review
}

export interface BillForAudit {
  billType: BillType;
  lineItems: LineItem[];
  statedTotal?: number;
  admissionDate?: string;
  dischargeDate?: string;
}

// ---------- Reference data (CMS) ----------

export type FeeScheduleName = 'PFS' | 'OPPS' | 'CLFS';

export interface FeeScheduleRate {
  schedule: FeeScheduleName;
  code: string;
  modifier?: string;
  description?: string;
  /** PFS only */
  nonFacilityRate?: number;
  /** PFS only */
  facilityRate?: number;
  /** OPPS and CLFS */
  rate?: number;
  /** OPPS: packaged into another service, no separate payment */
  packaged?: boolean;
  version: string; // e.g. "PFS 2026 Oct (RVU26D)"
}

/** NCCI edits come in two versions: practitioner (doctor) and hospital (outpatient). */
export type NcciVersion = 'practitioner' | 'hospital';

export interface NcciEdit {
  column1: string;
  column2: string;
  version: NcciVersion;
  /** 0 = never allowed together, 1 = allowed with an NCCI-associated modifier */
  modifierIndicator: 0 | 1;
  effectiveDate: string; // YYYY-MM-DD
  deletionDate?: string; // YYYY-MM-DD, edit no longer applies on or after this date
  dataVersion: string;
}

export interface MueLimit {
  code: string;
  version: NcciVersion;
  limit: number;
  /** MUE Adjudication Indicator: 1 = per claim line, 2 or 3 = per date of service */
  mai: 1 | 2 | 3;
  dataVersion: string;
}

/** Everything the engine needs, prefetched in batch for one bill. */
export interface ReferenceData {
  rates: FeeScheduleRate[];
  ncciEdits: NcciEdit[];
  mueLimits: MueLimit[];
}

// ---------- Findings ----------

export type CheckId =
  | 'duplicates'
  | 'math'
  | 'unbundling'
  | 'unit_limits'
  | 'pricing'
  | 'not_received'
  | 'outside_stay'
  | 'insurance_balance'
  | 'insurance_missing'
  | 'insurance_charge';

export type FindingCategory = 'billing_error' | 'pricing_concern' | 'insurance_issue' | 'info';

export interface Finding {
  id: string;
  checkId: CheckId;
  category: FindingCategory;
  lineItemIds: string[];
  /** Dollar amount in question */
  amount: number;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

export interface SkippedCheck {
  checkId: CheckId;
  reason: string;
}

export interface AuditResult {
  findings: Finding[];
  checksRun: CheckId[];
  checksSkipped: SkippedCheck[];
  totals: { billed: number; billingErrors: number; pricingConcerns: number };
}
