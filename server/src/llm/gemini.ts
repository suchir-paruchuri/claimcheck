import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config';
import type { Finding } from '../domain/types';
import { letterSectionsJsonSchema } from '../letters/letter';
import { ExtractionSchema, type LlmProvider } from './provider';

const EXTRACTION_PROMPT = `You are reading an itemized medical bill. Return every billed line item as JSON.
Rules:
- Copy codes exactly as printed. Never guess or correct a code.
- "sourceText" must be the exact text of that line as printed on the bill, including the code.
- Dates as YYYY-MM-DD. Money as plain numbers without $ or commas.
- Include revenueCode, placeOfService, typeOfBill, admission/discharge dates, and statedTotal only if printed on the bill.
- Do not include payments, adjustments, or insurance lines as line items.`;

const LETTER_PROMPT = `Write one short, factual paragraph for each finding below, for a patient's billing dispute letter.
Rules:
- Use only the facts in the finding. Do not add charges, amounts, or claims that are not there.
- "amount" is the dollar amount in dispute, which can be less than the line's full charge. Describe it that way.
- Write any dollar amount exactly as it appears in the finding's amount or evidence, formatted like $1,234.56.
- For "billing_error" findings, ask for the charge to be corrected or removed.
- For "pricing_concern" findings, ask the provider to justify or reduce the charge; do not call it an error.
- Return exactly one section per finding ID.`;

export class GeminiProvider implements LlmProvider {
  private ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

  private async generateJson(parts: object[], schema: unknown): Promise<unknown> {
    const res = await this.ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0 },
    });
    if (!res.text) throw new Error('Gemini returned an empty response');
    return JSON.parse(res.text);
  }

  extractBill(pdf: Uint8Array) {
    return this.generateJson(
      [{ inlineData: { mimeType: 'application/pdf', data: Buffer.from(pdf).toString('base64') } }, { text: EXTRACTION_PROMPT }],
      z.toJSONSchema(ExtractionSchema, { io: 'input' }),
    );
  }

  draftLetterSections(findings: Finding[], feedback: string[] = []) {
    const facts = findings.map(({ id, category, amount, message, evidence }) => ({ id, category, amount, message, evidence }));
    const retryNote = feedback.length ? `\nYour previous answer was rejected for these reasons; fix them:\n- ${feedback.join('\n- ')}` : '';
    return this.generateJson([{ text: `${LETTER_PROMPT}${retryNote}\n\nFindings:\n${JSON.stringify(facts, null, 2)}` }], letterSectionsJsonSchema);
  }
}
