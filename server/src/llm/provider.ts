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

/** Provider-agnostic interface, so Gemini can be swapped for another model later. */
export interface LlmProvider {
  extractBill(pdf: Uint8Array): Promise<unknown>;
  draftLetterSections(findings: Finding[], feedback?: string[]): Promise<unknown>;
}
