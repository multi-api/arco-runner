import type { Batcher } from '@multiapi/arco-cloud-client';

type Params = Record<string, unknown>;

/** Reports build steps as events with Arco's own shape (spec §6.8). */
export class Steps {
  private readonly startedAt = new Map<string, number>();

  constructor(private readonly batcher: Batcher, private readonly now: () => Date = () => new Date()) {}

  start(key: string, params: Params = {}): void {
    this.startedAt.set(key, this.now().getTime());
    this.emit(key, 'started', params);
  }

  done(key: string, message?: string): void {
    this.emit(key, 'done', {}, message, this.elapsed(key));
  }

  warning(key: string, message: string): void {
    this.emit(key, 'warning', {}, message, this.elapsed(key));
  }

  note(key: string, message: string, params: Params = {}): void {
    this.emit(key, 'note', params, message);
  }

  private elapsed(key: string): number | undefined {
    const t = this.startedAt.get(key);
    return t === undefined ? undefined : Math.max(0, this.now().getTime() - t);
  }

  private emit(key: string, status: string, params: Params, message?: string, elapsedMs?: number): void {
    this.batcher.addEvent({
      schema: 1,
      type: 'step',
      key,
      status,
      at: this.now().toISOString(),
      params,
      ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
      ...(message !== undefined ? { message } : {}),
    } as never);
  }
}
