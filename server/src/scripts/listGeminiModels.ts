/**
 * Lists the Gemini models this API key can call for text generation, so GEMINI_MODELS can be
 * set to exact IDs. Usage: npm run gemini:models [-- --all]
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../config';

async function main() {
  const showAll = process.argv.includes('--all');
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const ids: string[] = [];
  for await (const model of await ai.models.list()) {
    if (!model.supportedActions?.includes('generateContent')) continue;
    const id = (model.name ?? '').replace(/^models\//, '');
    if (showAll || /flash/.test(id)) ids.push(id);
  }
  ids.sort().reverse();
  const configured = new Set(config.gemini.models);
  console.log(showAll ? 'Models that support generateContent:' : 'Flash models that support generateContent (--all for every model):');
  for (const id of ids) console.log(`  ${configured.has(id) ? '*' : ' '} ${id}`);
  const missing = config.gemini.models.filter((m) => !ids.includes(m));
  console.log(`\n* = in your current chain: ${config.gemini.models.join(',')}`);
  if (missing.length) console.log(`Not available to this key (will be skipped): ${missing.join(', ')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
