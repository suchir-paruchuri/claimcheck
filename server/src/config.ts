import 'dotenv/config';

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
    model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
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
