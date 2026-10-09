import { AllModelsBusyError, classifyFailure, COOLDOWN_MS, ModelChain, NoModelsAvailableError } from '../src/llm/modelChain';

const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

/** A fake Gemini: each model either answers or throws the error given for it. */
function fakeClient(behavior: Record<string, Error | undefined>) {
  const calls: string[] = [];
  const call = async (model: string) => {
    calls.push(model);
    const err = behavior[model];
    if (err) throw err;
    return { answeredBy: model };
  };
  return { call, calls };
}

function makeChain(models = ['flash-a', 'flash-b', 'flash-c']) {
  let t = 1_000_000;
  const chain = new ModelChain(models, () => t, () => {});
  return { chain, advance: (ms: number) => (t += ms) };
}

describe('classifyFailure', () => {
  test.each([
    [503, 'busy'],
    [500, 'busy'],
    [429, 'rate_limited'],
    [404, 'unavailable'],
    [400, 'fatal'],
    [401, 'fatal'],
    [403, 'fatal'],
  ])('status %i is %s', (status, kind) => expect(classifyFailure(apiError(status))).toBe(kind));

  test('timeouts and network errors are treated as busy', () => {
    expect(classifyFailure(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toBe('busy');
    expect(classifyFailure(new Error('fetch failed'))).toBe('busy');
  });
});

describe('ModelChain', () => {
  test('uses the first model when it answers', async () => {
    const { chain } = makeChain();
    const fake = fakeClient({});
    await expect(chain.run(fake.call)).resolves.toEqual({ value: { answeredBy: 'flash-a' }, model: 'flash-a' });
    expect(fake.calls).toEqual(['flash-a']);
  });

  test('falls back to the next model on 503, 429, 404, and timeouts', async () => {
    const { chain } = makeChain(['a', 'b', 'c', 'd', 'e']);
    const fake = fakeClient({ a: apiError(503), b: apiError(429), c: apiError(404), d: new Error('timed out') });
    const result = await chain.run(fake.call);
    expect(result.model).toBe('e');
    expect(fake.calls).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('stops at a fatal error instead of trying other models', async () => {
    const { chain } = makeChain();
    const fake = fakeClient({ 'flash-a': apiError(400) });
    await expect(chain.run(fake.call)).rejects.toMatchObject({ status: 400 });
    expect(fake.calls).toEqual(['flash-a']);
  });

  test('throws a retryable busy error when every model is busy', async () => {
    const { chain } = makeChain();
    const fake = fakeClient({ 'flash-a': apiError(503), 'flash-b': apiError(429), 'flash-c': apiError(503) });
    const err = await chain.run(fake.call).catch((e) => e);
    expect(err).toBeInstanceOf(AllModelsBusyError);
    expect(err.message).toBe('The AI service is busy right now. Try again in a few minutes.');
    expect(err.status).toBeUndefined();
    expect(err.attempts.map((a: { model: string }) => a.model)).toEqual(['flash-a', 'flash-b', 'flash-c']);
  });

  test('throws a permanent error when no configured model exists', async () => {
    const { chain } = makeChain(['old-a', 'old-b']);
    const fake = fakeClient({ 'old-a': apiError(404), 'old-b': apiError(404) });
    const err = await chain.run(fake.call).catch((e) => e);
    expect(err).toBeInstanceOf(NoModelsAvailableError);
    expect(err.status).toBe(404);
  });

  test('skips a model while it cools down, then tries it again', async () => {
    const { chain, advance } = makeChain();
    const behavior: Record<string, Error | undefined> = { 'flash-a': apiError(503) };
    const fake = fakeClient(behavior);

    await chain.run(fake.call);
    expect(fake.calls).toEqual(['flash-a', 'flash-b']);

    behavior['flash-a'] = undefined; // recovered, but still cooling down
    fake.calls.length = 0;
    expect((await chain.run(fake.call)).model).toBe('flash-b');
    expect(fake.calls).toEqual(['flash-b']);

    advance(COOLDOWN_MS.busy + 1);
    fake.calls.length = 0;
    expect((await chain.run(fake.call)).model).toBe('flash-a');
  });

  test('rate-limited models cool down longer than busy ones', async () => {
    const { chain, advance } = makeChain(['a', 'b', 'c']);
    const behavior: Record<string, Error | undefined> = { a: apiError(429), b: apiError(503) };
    await chain.run(fakeClient(behavior).call);
    advance(COOLDOWN_MS.busy + 1);
    expect(chain.order()).toEqual(['b', 'c']);
    advance(COOLDOWN_MS.rate_limited);
    expect(chain.order()).toEqual(['a', 'b', 'c']);
  });

  test('when every model is cooling down, tries them all anyway, soonest to recover first', async () => {
    const { chain } = makeChain(['a', 'b']);
    const behavior: Record<string, Error | undefined> = { a: apiError(429), b: apiError(503) };
    await chain.run(fakeClient(behavior).call).catch(() => {});
    expect(chain.order()).toEqual(['b', 'a']);

    const fake = fakeClient({});
    expect((await chain.run(fake.call)).model).toBe('b');
  });
});
