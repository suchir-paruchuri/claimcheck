import mongoose from 'mongoose';
import { createApp } from './app';
import { config } from './config';

async function main() {
  void config.jwtSecret; // fail fast if missing
  await mongoose.connect(config.mongoUri);
  createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
