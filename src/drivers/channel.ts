import type { WorkerEvent } from './types.ts'

/** 单消费者事件队列：进程输出实时进入，RunningTurn.events 按顺序读出，final 后关闭。 */
export class TurnChannel {
  private readonly values: WorkerEvent[] = []
  private closed = false
  private waiting: (() => void) | undefined

  push(event: WorkerEvent): void {
    if (this.closed) return
    this.values.push(event)
    this.waiting?.()
  }

  close(): void {
    this.closed = true
    this.waiting?.()
  }

  get iterable(): AsyncIterable<WorkerEvent> {
    const channel = this
    return {
      async *[Symbol.asyncIterator]() {
        let index = 0
        for (;;) {
          if (index < channel.values.length) { yield channel.values[index++]!; continue }
          if (channel.closed) return
          await new Promise<void>(resolve => { channel.waiting = () => { channel.waiting = undefined; resolve() } })
        }
      },
    }
  }
}
