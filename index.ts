import eio from 'engine.io-client'
import cuid from 'cuid'
import ruta from 'ruta3'
import Backoff from 'backo2'
import {
  encode,
  decode,
  protocolVersion,
  NydusResultMessage,
  MessageType,
  NydusErrorMessage,
  NydusPublishMessage,
} from 'nydus-protocol'
import { TypedEventEmitter } from './typed-emitter'

export { protocolVersion }

export interface NydusClientOptions extends eio.SocketOptions {
  /**
   * How long before a connection attempt should be considered failed. Optional, will not timeout
   * if not specified.
   */
  connectTimeout?: number
  /** How many times to attempt to reconnect before giving up. */
  reconnectionAttempts: number
  /**
   * How long to wait before attempting to reconnect, in milliseconds. This time will be backed off
   * if successive attempts fail.
   */
  reconnectionDelay: number
  /**
   * The maximum amount of time to wait before attempting to reconnect, in milliseconds, when backed
   * off. */
  reconnectionDelayMax: number
  /**
   * How much to jitter reconnection attempts, to avoid all clients connecting at once. This value
   * should be between 0 and 1.
   */
  reconnectionJitter: number
}

interface ExpandedSocket extends eio.Socket {
  readonly readyState: string
}

interface TransportError extends Error {
  readonly type: 'TransportError'
  readonly description: Error
}

function isTransportError(err: Error): err is TransportError {
  return (err as any).type === 'TransportError'
}

export interface RouteInfo {
  route: string
  params: Record<string, string>
  splats: string[]
}

export type RouteHandler = (routeInfo: RouteInfo, data: any) => void

interface NydusEvents {
  /** Fired when the connection succeeds. */
  connect: () => void
  /** Fired when the connection has been closed */
  disconnect: (reason: string, details?: Error) => void
  /** Fired when a reconnect attempt is being initiated. */
  reconnecting: (attempts: number) => void
  /** Fired when a publish occurred that wasn't handled by any registered routes. */
  unhandled: (published: { path: string; data: any }) => void

  /** Fired when a general error occurs. */
  error: (err: Error) => void
  /** Fired when the connection attempt times out. */
  // eslint-disable-next-line camelcase
  connect_timeout: () => void
  /** Fired when the reconnection attempts exceeded the maximum allowed without success. */
  // eslint-disable-next-line camelcase
  reconnect_failed: () => void
  /** Fired when the connection attempt failed. */
  // eslint-disable-next-line camelcase
  connect_failed: () => void
}

export class InvokeError extends Error {
  readonly status: number
  readonly body: any

  constructor(message: string, status: number, body?: any) {
    super(message)
    this.status = status
    this.body = body
  }
}

type PromiseCompleters = { resolve: (value: unknown) => void; reject: (reason: any) => void }

export class NydusClient extends TypedEventEmitter<NydusEvents> {
  readonly host: string
  readonly opts: Partial<NydusClientOptions>
  conn: ExpandedSocket | null = null

  private outstanding = new Map<string, PromiseCompleters>()
  private router = ruta<RouteHandler>()
  private backoff: Backoff

  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  private wasOpened = false
  private skipReconnect = false

  constructor(host: string, opts: Partial<NydusClientOptions> = {}) {
    super()
    this.host = host
    this.opts = opts

    this.opts.reconnectionAttempts = this.opts.reconnectionAttempts || Infinity
    this.backoff = new Backoff({
      min: opts.reconnectionDelay || 1000,
      max: opts.reconnectionDelayMax || 10000,
      jitter: opts.reconnectionJitter || 0.5,
    })
  }

  // One of: opening, open, closing, closed.
  get readyState() {
    return this.conn != null ? this.conn.readyState : 'closed'
  }

  private doConnect() {
    if (this.opts.connectTimeout) {
      this.connectTimer = setTimeout(() => {
        this.emit('connect_timeout')
        this.disconnect()
        this.skipReconnect = false
        this.onClose('connect timeout')
      }, this.opts.connectTimeout)
    }

    this.conn = eio(this.host, this.opts) as ExpandedSocket
    this.conn
      .on('open', this.onOpen.bind(this))
      .on('message', data => this.onMessage(data as string))
      .on('close', this.onClose.bind(this))
      .on('error', this.onError.bind(this))
  }

  // Connect to the server. If already connected, this will be a no-op.
  connect() {
    if (this.conn) return

    this.skipReconnect = false
    this.wasOpened = false
    this.doConnect()
  }

  reconnect() {
    if (this.conn || this.skipReconnect || this.backoffTimer) {
      return
    }

    if (this.backoff.attempts >= this.opts.reconnectionAttempts!) {
      this.backoff.reset()
      this.emit('reconnect_failed')
      return
    }

    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      this.emit('reconnecting', this.backoff.attempts)

      if (this.skipReconnect || this.conn) return

      this.doConnect()
    }, this.backoff.duration())
  }

  // Disconnect from the server. If not already connected, this will be a no-op.
  disconnect() {
    this.skipReconnect = true
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }

    if (!this.conn) return

    this.conn.close()
  }

  /**
   * Registers a handler function to respond to PUBLISHes to paths matching a specified pattern.
   * Handlers are normal functions of the form:
   * `function({ route, params, splats }, data)`
   *
   * PUBLISHes that don't match a route will be emitted as an 'unhandled' event on this object,
   * which can be useful to track in development mode.
   */
  registerRoute(pathPattern: string, handler: RouteHandler) {
    this.router.addRoute(pathPattern, handler)
  }

  private onPublish({ path, data }: NydusPublishMessage<any>) {
    const route = this.router.match(path)
    if (!route) {
      this.emit('unhandled', { path, data })
      return
    }

    route.action({ route: route.route, params: route.params, splats: route.splats }, data)
  }

  /**
   * Invoke a remote method on the server, specified via a path. Optionally, data can be specified
   * to send along with the call (will be JSON encoded). A Promise will be returned, resolved or
   * rejected with the result or error (respectively) from the server.
   */
  invoke(path: string, data?: any) {
    const id = cuid()
    const p = new Promise((resolve, reject) => {
      if (!this.conn) {
        reject(new Error('Not connected'))
        return
      }

      this.outstanding.set(id, { resolve, reject })
      this.conn.send(encode(MessageType.Invoke, data, id, path))
    }).catch(err => {
      // Convert error-like objects back to Errors
      if (err.message && err.status) {
        const converted = new InvokeError(err.message, err.status, err.body)
        throw converted
      }

      throw err
    })

    p.finally(() => this.outstanding.delete(id))

    return p
  }

  private onInvokeResponse({ type, id, data }: NydusResultMessage<any> | NydusErrorMessage<any>) {
    const p = this.outstanding.get(id)
    if (!p) {
      this.emit('error', new Error('Unknown invoke id'))
      return
    }

    p[type === MessageType.Result ? 'resolve' : 'reject'](data)
  }

  private onOpen() {
    this.clearConnectTimer()
    this.wasOpened = true
    this.backoff.reset()
    this.emit('connect')
  }

  private onMessage(msg: string) {
    const decoded = decode(msg)
    switch (decoded.type) {
      case MessageType.ParserError:
        this.conn?.close() // will cause a call to _onClose
        break
      case MessageType.Welcome:
        if (decoded.data !== protocolVersion) {
          this.emit(
            'error',
            new Error('Server has incompatible protocol version: ' + protocolVersion),
          )
          this.conn?.close()
        }
        break
      case MessageType.Result:
      case MessageType.Error:
        this.onInvokeResponse(decoded)
        break
      case MessageType.Publish:
        this.onPublish(decoded)
        break
    }
  }

  private onClose(reason: string, details?: Error) {
    this.clearConnectTimer()
    this.conn = null

    if (!this.wasOpened) {
      this.emit('connect_failed')
      this.reconnect()
      // Sockets can emit 'close' even if the connection was never actually opened. Don't emit emits
      // upstream in that case, since they're rather unnecessary
      return
    }

    this.emit('disconnect', reason, details)
    this.outstanding.clear()
    this.wasOpened = false
    this.reconnect()
  }

  private onError(err: Error | TransportError) {
    this.clearConnectTimer()
    if (isTransportError(err) && err.message === 'xhr poll error') {
      this.onClose('error', err)
      return
    }
    if (
      this.skipReconnect &&
      isTransportError(err) &&
      err.description &&
      err.description.message &&
      err.description.message.includes('closed before the connection was established')
    ) {
      // ws sometimes throws errors if you disconnect a socket that was in the process of
      // reconnecting. Since the disconnect was requested (_skipReconnect is true), this seems
      // spurious, so we just ignore it
      return
    }

    this.emit('error', err)
  }

  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }
}

export default function createClient(host: string, opts?: Partial<NydusClientOptions>) {
  return new NydusClient(host, opts)
}
