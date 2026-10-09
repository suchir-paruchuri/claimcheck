import mongoose from 'mongoose';
import { config } from './config';
import { getAgenda } from './jobs/queue';
import { registerProcessors } from './jobs/processors';
import { GeminiProvider } from './llm/gemini';

async function main() {
  await mongoose.connect(config.mongoUri);
  registerProcessors(new GeminiProvider());
  const agenda = getAgenda();
  await agenda.start();
  console.log('Worker started');

  const shutdown = async () => {
    await agenda.stop(); // releases locks so another worker can pick jobs up immediately
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
