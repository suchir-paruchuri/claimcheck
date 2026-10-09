/**
 * Runs a Gemini request against a list of models, best first. When a model is overloaded or
 * out of quota, the request moves on to the next one, and that model is skipped for a while
 * so later jobs don't waste a call on it.
 */

export type FailureKind = 'busy' | 'rate_limited' | 'unavailable' | 'fatal';

/** How long a model is skipped after each kind of failure. */
export const COOLDOWN_MS: Record<Exclude<FailureKind, 'fatal'>, number> = {
  busy: 2 * 60_000, // 503 "high demand", 5xx, timeouts: usually clears quickly
  rate_limited: 10 * 60_000, // 429: per-minute or daily quota used up
  unavailable: 60 * 60_000, // 404: this API key can't use the model
};

/**
 * - 429 → rate limited (try the next model; each model has its own quota)
 * - 404 → this key can't use the model (skip it)
 * - other 4xx (bad request, invalid key, permission) → fatal: every model would fail the same way
 * - 5xx, timeouts, network errors, empty responses → busy (try the next model)
 */
export function classifyFailure(err: unknown): FailureKind {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'unavailable';
    if (status >= 400 && status < 500) return 'fatal';
  }
  return 'busy';
}

/** Every model failed with a temporary problem. Not a 4xx, so the job queue retries it later. */
export class AllModelsBusyError extends Error {
  constructor(public readonly attempts: { model: string; error: string }[]) {
    super('The AI service is busy right now. Try again in a few minutes.');
    this.name = 'AllModelsBusyError';
  }
}

/** None of the configured models exist for this API key; retrying won't help. */
export class NoModelsAvailableError extends Error {
  readonly status = 404;
  constructor(models: string[]) {
    super(`None of the configured Gemini models are available to this API key (${models.join(', ')}). Run "npm run gemini:models" and update GEMINI_MODELS.`);
    this.name = 'NoModelsAvailableError';
  }
}

export interface ChainResult<T> {
  value: T;
  model: string;
}

const describe = (err: unknown) => {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : String(err);
  return typeof status === 'number' ? `${status}: ${message.slice(0, 200)}` : message.slice(0, 200);
};

export class ModelChain {
  private cooldownUntil = new Map<string, number>();

  constructor(
    readonly models: string[],
    private now: () => number = Date.now,
    private log: (msg: string) => void = (msg) => console.warn(msg),
  ) {
    if (models.length === 0) throw new Error('At least one Gemini model must be configured');
  }

  /**
   * Models to try, in order: the ones not cooling down, best first. If every model is cooling
   * down, all of them are tried anyway (soonest to recover first) rather than failing outright.
   */
  order(): string[] {
    const t = this.now();
    const ready = this.models.filter((m) => (this.cooldownUntil.get(m) ?? 0) <= t);
    if (ready.length) return ready;
    return [...this.models].sort((a, b) => this.cooldownUntil.get(a)! - this.cooldownUntil.get(b)!);
  }

  async run<T>(call: (model: string) => Promise<T>): Promise<ChainResult<T>> {
    const attempts: { model: string; error: string; kind: FailureKind }[] = [];
    for (const model of this.order()) {
      try {
        const value = await call(model);
        this.cooldownUntil.delete(model);
        if (attempts.length) this.log(`[gemini] ${model} answered after ${attempts.map((a) => a.model).join(', ')} failed`);
        return { value, model };
      } catch (err) {
        const kind = classifyFailure(err);
        if (kind === 'fatal') throw err;
        this.cooldownUntil.set(model, this.now() + COOLDOWN_MS[kind]);
        attempts.push({ model, error: describe(err), kind });
        this.log(`[gemini] ${model} failed (${kind}, ${describe(err)}); trying the next model`);
      }
    }
    if (attempts.every((a) => a.kind === 'unavailable')) throw new NoModelsAvailableError(this.models);
    throw new AllModelsBusyError(attempts);
  }
}
