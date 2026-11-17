/**
 * Ordin 自己的 HTTP 服务：node:http，只绑 loopback，port 0 由操作系统分配端口。
 *
 * 取代 ordin 插件时代的 `ctx.webServer.register`（docs/p2/runtime-analysis.md §5 P2-T2）：
 * 面板与 API 不再寄生在 DSH 的 webServer 上，进程自己 listen。本文件只管 socket 生命周期；
 * 路由表、sameOrigin 守卫与活动请求集合在 http.ts。
 *
 * 关闭语义：close() 停止接受新连接并关闭空闲连接（Node >= 19 的 server.close 自带空闲回收，
 * 再显式 closeIdleConnections 一次），进行中的响应不被掐断；handler 级的等待由 http.ts 的
 * drain() 负责，全局超时归 boot 的 stop（15s，runtime-analysis §1.4）。这里不设内部超时：
 * 挂死的 handler 必须让 stop 的超时报警可见，而不是在 socket 层被悄悄吞掉（AGENTS.md A7）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ServerOptions {
  /** 监听端口；0（默认）由操作系统分配，隔离测试与首次启动都靠它。 */
  readonly port?: number
  /** 绑定地址；默认且只允许 loopback。面板是管理面，绑到非 loopback 直接把管理面暴露给网络。 */
  readonly host?: string
  /** handler 异常的可见去处（http.ts 接 host.context.logger）；不设则错误只体现在 500 响应里。 */
  readonly onError?: (error: unknown) => void
}

export interface RunningServer {
  /** 实际绑定的端口——port: 0 时只有 listen 之后才知道，配置值不是事实（A2）。 */
  readonly port: number
  /** 实际绑定地址（恒为 loopback）。 */
  readonly host: string
  /** 面板根 URL，日志与 boot 的启动行用。 */
  readonly url: string
  /** 停止接受新连接并关闭空闲连接；进行中的响应自然结束后 'close' 才触发。幂等。 */
  close(): Promise<void>
  /**
   * 关掉仍挂着的连接（close() 当时是活动的、之后才变空闲的 keep-alive socket）。
   * 只应在 handler 已 drain 完时调用——此时它们不再承载进行中的响应，否则就是掐断。
   */
  forceClose(): void
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * 起一台 loopback HTTP server。listen 失败（如端口被占）以原始错误 reject，不降级、不换端口——
 * 操作者配置的端口被占是必须看见的事实，悄悄换端口会让面板开在没人知道的地方。
 */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) throw new Error(`Ordin 的管理面板只绑定 loopback，拒绝绑定 ${host}`)
  const server = createServer((req, res) => {
    // handler 的异常不能变成 unhandledRejection：响应兜底 500，错误交给 onError 保持可见。
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      options.onError?.(error)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`Ordin 内部错误：${error instanceof Error ? error.message : String(error)}`)
        } else res.destroy()
      } catch { /* 连接已死；错误已经交给 onError */ }
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => { reject(error) }
    server.once('error', onListenError)
    server.listen(options.port ?? 0, host, () => { server.off('error', onListenError); resolve() })
  })
  // listen 之后的 server 错误（罕见）同样要有去处，不能成为没有监听者的 'error' 事件。
  server.on('error', error => { options.onError?.(error) })
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('Ordin HTTP server listen 后没有绑定地址')
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    server.closeIdleConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    })
  }
  const forceClose = (): void => { server.closeAllConnections() }
  return { port: address.port, host: address.address, url: `http://127.0.0.1:${address.port}`, close, forceClose }
}
