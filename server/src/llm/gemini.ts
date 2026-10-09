import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config';
import type { Finding } from '../domain/types';
import { letterSectionsJsonSchema } from '../letters/letter';
import { ModelChain } from './modelChain';
import { EobExtractionSchema, ExtractionSchema, type LlmProvider, type LlmResult } from './provider';

const EXTRACTION_PROMPT = `You are reading an itemized medical bill. Return every billed line item as JSON.
Rules:
- Copy codes exactly as printed. Never guess or correct a code.
- "sourceText" must be the exact text of that line as printed on the bill, including the code.
- Dates as YYYY-MM-DD. Money as plain numbers without $ or commas.
- Include revenueCode, placeOfService, typeOfBill, admission/discharge dates, statedTotal (total charges), and amountDue (the balance the patient is asked to pay) only if printed on the bill.
- Do not include payments, adjustments, or insurance lines as line items.`;

const EOB_PROMPT = `You are reading a health insurance Explanation of Benefits (EOB). Return every service line as JSON.
Rules:
- Copy codes exactly as printed, and leave "code" out if the statement doesn't show one. Never guess a code.
- "billed" is the amount the provider charged the insurer. "patientResponsibility" is everything the patient owes for that line (deductible, copay, coinsurance, and amounts not covered).
- "sourceText" must be the exact text of that line as printed.
- Dates as YYYY-MM-DD. Money as plain numbers without $ or commas.
- Do not include summary or total rows as lines.`;

const LETTER_PROMPT = `Write one short, factual paragraph for each finding below, for a patient's billing dispute letter.
Rules:
- Use only the facts in the finding. Do not add charges, amounts, or claims that are not there.
- "amount" is the dollar amount in dispute, which can be less than the line's full charge. Describe it that way.
- Write any dollar amount exactly as it appears in the finding's amount or evidence, formatted like $1,234.56.
- For "billing_error" findings, ask for the charge to be corrected or removed.
- For "pricing_concern" findings, ask the provider to justify or reduce the charge; do not call it an error.
- For "insurance_issue" findings, ask the provider to confirm the charge was submitted to the patient's insurer, or to correct the amount, before billing the patient.
- Return exactly one section per finding ID.`;

export class GeminiProvider implements LlmProvider {
  private ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  private chain = new ModelChain(config.gemini.models);

  /** Sends the request to the first model that answers; see ModelChain for the fallback rules. */
  private async generateJson(parts: object[], schema: unknown): Promise<LlmResult> {
    const { value, model } = await this.chain.run(async (model) => {
      const res = await this.ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0,
          abortSignal: AbortSignal.timeout(config.gemini.timeoutMs),
        },
      });
      if (!res.text) throw new Error(`${model} returned an empty response`);
      return JSON.parse(res.text) as unknown;
    });
    return { data: value, model };
  }

  extractBill(pdf: Uint8Array) {
    return this.generateJson(
      [{ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } }, { text: EXTRACTION_PROMPT }],
      z.toJSONSchema(ExtractionSchema, { io: 'input' }),
    );
  }

  extractEob(pdf: Uint8Array) {
    return this.generateJson(
      [{ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } }, { text: EOB_PROMPT }],
      z.toJSONSchema(EobExtractionSchema, { io: 'input' }),
    );
  }

  draftLetterSections(findings: Finding[], feedback: string[] = []) {
    const facts = findings.map(({ id, category, amount, message, evidence }) => ({ id, category, amount, message, evidence }));
    const retryNote = feedback.length ? `\nYour previous answer was rejected for these reasons; fix them:\n- ${feedback.join('\n- ')}` : '';
    return this.generateJson([{ text: `${LETTER_PROMPT}${retryNote}\n\nFindings:\n${JSON.stringify(facts, null, 2)}` }], letterSectionsJsonSchema);
  }
}
