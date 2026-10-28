import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '@elastic/elasticsearch';

const context = new AsyncLocalStorage<{ signal: AbortSignal; deadline: number }>();

export function searchTimeout(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 50 && value <= maximum ? value : fallback;
}

export function searchSignal(): AbortSignal | undefined {
  return context.getStore()?.signal;
}

/** 공유 작업은 첫 호출자의 남은 예산 대신 짧은 자체 예산을 가진다. 대기자는 외부 검색 예산으로 종료한다. */
export function withSharedSearchBudget<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  if (!context.getStore()) return work();
  return context.exit(() => withSearchBudget(timeoutMs, work));
}

/** 하위 요청도 중단하고, 이미 진행 중인 공유 작업을 기다리는 호출의 예산도 제한한다. */
export async function withSearchBudget<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  const controller = new AbortController();
  const deadline = Math.min(Date.now() + timeoutMs, parent?.deadline ?? Infinity);
  const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => {
    const error = new Error('검색 요청 제한 시간을 초과했습니다.');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, Math.max(0, deadline - Date.now()));
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    return await context.run({ signal, deadline }, () => Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

const wrapped = new WeakSet<object>();

/** 검색 문맥에서만 공용 ES transport에 제한을 적용한다. 색인 timeout은 유지한다. */
export function applySearchBudget(client: Client): Client {
  if (wrapped.has(client.transport)) return client;
  wrapped.add(client.transport);
  const request = client.transport.request.bind(client.transport);
  client.transport.request = ((params: Parameters<typeof request>[0], options?: Parameters<typeof request>[1]) => {
    const budget = context.getStore();
    if (!budget) return request(params, options);
    budget.signal.throwIfAborted();
    const timeout = Math.max(1, Math.min(budget.deadline - Date.now(), searchTimeout('SEARCH_ES_TIMEOUT_MS', 5000, 5000), typeof options?.requestTimeout === 'number' ? options.requestTimeout : Infinity));
    return request(params, {
      ...options,
      maxRetries: 0,
      requestTimeout: timeout,
      // ES transport가 직접 보내는 abort 이벤트를 검색 전체 signal과 분리한다.
      signal: AbortSignal.any([budget.signal, ...options?.signal ? [options.signal] : []]),
    });
  }) as typeof client.transport.request;
  return client;
}
