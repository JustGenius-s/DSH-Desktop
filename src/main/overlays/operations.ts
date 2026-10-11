/** Serialize each contributor's opens; closing invalidates even queued work. */
export function createOverlayOperations() {
  const queues = new Map<string, { tail: Promise<unknown> }>()

  return {
    run<T>(key: string, task: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
      let queue = queues.get(key)
      if (queue === undefined) {
        queue = { tail: Promise.resolve() }
        queues.set(key, queue)
      }
      const current = queue
      const isCurrent = (): boolean => queues.get(key) === current
      const result = current.tail.then(() => {
        if (!isCurrent()) throw new Error('desktop overlay closed while loading')
        return task(isCurrent)
      })
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      current.tail = tail
      void tail.then(() => {
        if (isCurrent() && current.tail === tail) queues.delete(key)
      })
      return result
    },
    cancel(key: string): void {
      queues.delete(key)
    },
    cancelAll(): void {
      queues.clear()
    },
  }
}
