import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config';
import { letterSectionsJsonSchema } from '../letters/letter';
import { ModelChain } from './modelChain';
import { EobExtractionSchema, ExtractionSchema, type LetterFinding, type LlmProvider, type LlmResult } from './provider';

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

const LETTER_PROMPT = `Write one short, factual paragraph for each finding below, for a patient's billing dispute letter to the provider's billing office.
Rules:
- Write in the first person, as the patient ("my bill", "my insurer"). The findings are written to the patient ("you"); rephrase them.
- Use only the facts in the finding. Do not add charges, amounts, or claims that are not there.
- Name the service in parentheses after its code, using "services" (for example, "Code 93000 (electrocardiogram)").
- Write any dollar amount exactly as it appears in the finding's amount or evidence, formatted like $1,234.56.
- Write dates like September 14, 2026. Say "the Medicare rate" and "Medicare's limit", not "benchmark" or "CMS". Leave out the flagging threshold and the phrase "disputed amount".
- Vary how paragraphs open; don't start each one with the date.
- Never mention finding IDs, line IDs, or statement IDs. You may cite the insurer's name and claim number.
- For "billing_error" findings, ask for the charge to be removed or corrected, naming the amount to remove.
- For "pricing_concern" findings, give the charge and the Medicare rate, rounding the multiple ("about 9 times"), and ask the provider to explain how the charge was set or reduce it. Do not call it an error and do not state a difference to remove.
- For "insurance_missing", ask the provider to confirm the charge was submitted to the insurer, and to submit it if not, before billing the patient.
- For "insurance_charge", ask the provider to correct the bill to match what the insurer was billed, or explain the difference.
- For "insurance_balance", ask for a corrected balance, and note that the other corrections in the letter may resolve part of the difference.
- Return exactly one section per finding ID.

Examples of the style wanted:
- "Code 85025 (CBC with automated differential) is billed twice on September 14, 2026, with identical units and modifiers. Please remove the repeated $64.00 charge."
- "Code 80053 (comprehensive metabolic panel) is billed at $186.00, about 18 times the Medicare rate of $10.56. Please explain how this charge was set, or reduce it."`;

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

  draftLetterSections(findings: LetterFinding[], feedback: string[] = []) {
    const facts = findings.map(({ id, checkId, category, amount, message, evidence, services }) => ({ id, checkId, category, amount, message, evidence, services }));
    const retryNote = feedback.length ? `\nYour previous answer was rejected for these reasons; fix them:\n- ${feedback.join('\n- ')}` : '';
    return this.generateJson([{ text: `${LETTER_PROMPT}${retryNote}\n\nFindings:\n${JSON.stringify(facts, null, 2)}` }], letterSectionsJsonSchema);
  }
}
