import { parseGeminiModels } from '../src/config';

describe('parseGeminiModels', () => {
  it('reads a comma-separated chain, trimming spaces and a models/ prefix', () => {
    expect(parseGeminiModels(' gemini-3.8-flash, models/gemini-3.7-flash ,gemini-3.8-flash')).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
  });

  it('falls back to the default Flash chain when unset', () => {
    expect(parseGeminiModels(undefined)[0]).toBe('gemini-3.8-flash');
  });

  it('rejects a pasted-together .env line with a clear error', () => {
    expect(() => parseGeminiModels('GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash')).toThrow(/Invalid Gemini model name\(s\) in \.env: "GEMINI_MODELS=gemini-3.8-flash"/);
  });
});
