import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DSH_HOST = '127.0.0.1'

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

export function readWebPort(userData: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(join(userData, 'web-port.json'), 'utf8')) as { port?: unknown } | null
    return validPort(value?.port) ? value.port : undefined
  } catch {
    return undefined
  }
}

/** Remember only a successfully booted port, never the launch URL or its token. */
export function rememberWebPort(userData: string, port: number): void {
  if (!validPort(port)) throw new Error('invalid web port')
  mkdirSync(userData, { recursive: true })
  const file = join(userData, 'web-port.json')
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify({ port })}\n`, { encoding: 'utf8', flush: true })
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Reuse the previous origin when free; never connect to whoever occupies it. */
export async function findFreePort(preferred?: number): Promise<number> {
  if (validPort(preferred)) {
    try {
      return await allocate(preferred)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  return allocate(0)
}

function allocate(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(port, DSH_HOST, () => {
      const address = server.address()
      const selected = typeof address === 'object' && address !== null ? address.port : 0
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve(selected)
      })
    })
  })
}
