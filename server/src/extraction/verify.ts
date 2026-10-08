// Independent verification of LLM-extracted line items. The model never reports its own
// confidence; every status comes from deterministic checks against the PDF text and CMS data.

export type ExtractionStatus = 'verified' | 'needs_review' | 'unverified';

export interface ExtractedItem {
  code: string;
  description: string;
  sourceText: string; // exact text the model says it read from the bill
  charge: number;
}

export interface Verification {
  foundInDocument: boolean;
  cmsMatch: boolean;
  descriptionMatch: boolean;
}

export interface VerifiedItem {
  verification: Verification;
  extractionStatus: ExtractionStatus;
  source?: { page: number; text: string };
  reasons: string[];
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Finds which page contains the item's source text, and confirms the extracted code
 * itself appears in that text. A misread code (99283 read as 99285) fails here even
 * though it exists in CMS data and has a similar description.
 */
export function locateInDocument(item: ExtractedItem, pageTexts: string[]): { page: number; text: string } | undefined {
  const needle = normalize(item.sourceText);
  if (!needle) return undefined;
  const codeRe = new RegExp(`(^|[^0-9a-z])${item.code.toLowerCase()}([^0-9a-z]|$)`);
  for (let i = 0; i < pageTexts.length; i++) {
    const page = normalize(pageTexts[i]);
    if (page.includes(needle) && codeRe.test(needle)) return { page: i + 1, text: item.sourceText };
  }
  return undefined;
}

const tokens = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/** "dept" abbreviates "department": same first letter, and its letters appear in order. */
function isAbbreviation(short: string, long: string): boolean {
  if (short.length < 3 || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

const tokensMatch = (a: string, b: string) =>
  a === b || (a.length <= b.length ? isAbbreviation(a, b) : isAbbreviation(b, a));

/**
 * Loose text similarity between the bill's description and CMS's short descriptor:
 * the share of CMS descriptor words that appear on the bill. CMS descriptors are
 * abbreviated ("Emergency dept visit hi mdm"), so abbreviations count as matches.
 */
export function descriptionSimilarity(billDescription: string, cmsDescription: string): number {
  const cms = tokens(cmsDescription);
  const bill = tokens(billDescription);
  if (cms.length === 0 || bill.length === 0) return 0;
  // Take the better of both directions: a terse bill line ("Routine venipuncture") can match
  // a wordier CMS descriptor, and vice versa.
  const cmsCovered = cms.filter((c) => bill.some((b) => tokensMatch(c, b))).length / cms.length;
  const billCovered = bill.filter((b) => cms.some((c) => tokensMatch(c, b))).length / bill.length;
  return Math.max(cmsCovered, billCovered);
}

export const DESCRIPTION_MATCH_THRESHOLD = 0.34;

export function verifyItem(
  item: ExtractedItem,
  pageTexts: string[],
  cmsDescription: string | undefined,
): VerifiedItem {
  const source = locateInDocument(item, pageTexts);
  const cmsMatch = cmsDescription !== undefined;
  const descriptionMatch = cmsMatch && descriptionSimilarity(item.description, cmsDescription!) >= DESCRIPTION_MATCH_THRESHOLD;
  const verification = { foundInDocument: !!source, cmsMatch, descriptionMatch };

  const reasons: string[] = [];
  if (!source) reasons.push(`Code ${item.code} was not found on the bill as extracted.`);
  if (!cmsMatch) reasons.push(`Code ${item.code} is not in Medicare's reference data, so it could not be verified.`);
  else if (!descriptionMatch) reasons.push(`The bill's description doesn't match CMS's description for code ${item.code}.`);

  let extractionStatus: ExtractionStatus;
  if (!source) extractionStatus = 'needs_review';
  else if (!cmsMatch) extractionStatus = 'unverified';
  else if (!descriptionMatch) extractionStatus = 'needs_review';
  else extractionStatus = 'verified';

  return { verification, extractionStatus, source, reasons };
}

export function totalsReconcile(charges: number[], statedTotal: number | undefined): boolean | undefined {
  if (statedTotal === undefined) return undefined;
  const sum = charges.reduce((s, c) => s + c, 0);
  return Math.abs(sum - statedTotal) <= 0.01;
}
