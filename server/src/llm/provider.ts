import { z } from 'zod';
import type { Finding } from '../domain/types';

/** What the model returns for one bill. It never reports confidence scores or coordinates. */
export const ExtractionSchema = z.object({
  providerName: z.string().optional(),
  accountNumber: z.string().optional(),
  typeOfBill: z.string().optional(),
  admissionDate: z.string().optional(),
  dischargeDate: z.string().optional(),
  statedTotal: z.number().optional(),
  amountDue: z.number().optional().describe('The balance the patient is asked to pay, after any insurance payments and adjustments'),
  lineItems: z.array(
    z.object({
      code: z.string(),
      description: z.string(),
      revenueCode: z.string().optional(),
      modifiers: z.array(z.string()).default([]),
      units: z.number().default(1),
      unitPrice: z.number().optional(),
      charge: z.number(),
      dateOfService: z.string(),
      placeOfService: z.string().optional(),
      sourceText: z.string().describe('The exact text of this line as printed on the bill, including the code'),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** What the model returns for an insurance statement (Explanation of Benefits). */
export const EobExtractionSchema = z.object({
  payer: z.string().optional(),
  claimNumber: z.string().optional(),
  providerName: z.string().optional(),
  lines: z.array(
    z.object({
      dateOfService: z.string(),
      code: z.string().optional(),
      description: z.string(),
      billed: z.number().describe('Amount the provider billed the insurer'),
      allowed: z.number().optional(),
      planPaid: z.number().optional(),
      patientResponsibility: z.number().describe('Total the patient owes for this line: deductible + copay + coinsurance + amounts not covered'),
      sourceText: z.string().describe('The exact text of this line as printed on the statement'),
    }),
  ),
});
export type EobExtraction = z.infer<typeof EobExtractionSchema>;

/** Provider-agnostic interface, so Gemini can be swapped for another model later. */
export interface LlmProvider {
  extractBill(pdf: Uint8Array): Promise<unknown>;
  extractEob(pdf: Uint8Array): Promise<unknown>;
  draftLetterSections(findings: Finding[], feedback?: string[]): Promise<unknown>;
}
