import 'dotenv/config';

/** Flash models only, best first. Each has its own free-tier quota, so falling back also spreads the load. */
const DEFAULT_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash'];

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]*$/i;

/** GEMINI_MODELS is a comma-separated chain; GEMINI_MODEL (one model) still works. */
export function parseGeminiModels(raw: string | undefined): string[] {
  const models = (raw ?? '').split(',').map((m) => m.trim().replace(/^models\//, '')).filter(Boolean);
  // Catch a pasted-together .env line (GEMINI_MODEL=GEMINI_MODELS=...) at startup, not on the first bill.
  const bad = models.filter((m) => !MODEL_ID_RE.test(m));
  if (bad.length) throw new Error(`Invalid Gemini model name(s) in .env: ${bad.map((m) => `"${m}"`).join(', ')}. Expected IDs like gemini-3.8-flash, separated by commas.`);
  return models.length ? [...new Set(models)] : DEFAULT_GEMINI_MODELS;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/claimcheck',
  get jwtSecret() {
    return required('JWT_SECRET');
  },
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  gemini: {
    get apiKey() {
      return required('GEMINI_API_KEY');
    },
    get models() {
      return parseGeminiModels(process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL);
    },
    // A request that hasn't answered by then counts as busy and moves to the next model.
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 120_000),
  },
  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    get bucket() {
      return required('S3_BUCKET');
    },
  },
  benchmarkMultiplier: Number(process.env.BENCHMARK_MULTIPLIER ?? 3),
  isProduction: process.env.NODE_ENV === 'production',
};
