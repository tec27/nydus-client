import * as chai from 'chai'
import { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import { AddressInfo } from 'net'

import nydus, { NydusServer } from 'nydus'
import { decode, encode, MessageType } from 'nydus-protocol'
import client, { InvokeError, NydusClient, protocolVersion, RouteInfo } from '../index.js'

chai.use(chaiAsPromised)

async function helloHandler() {
  return 'hi'
}

async function errorMeHandler() {
  throw new InvokeError('Ya done goofed', 420)
}

describe('client', () => {
  let httpServer: http.Server | undefined
  let nydusServer: NydusServer | undefined
  let port: number
  const clients: NydusClient[] = []
  const allowRequestFilters: Array<(req: http.IncomingMessage) => boolean> = []
  /**
   * Each entry takes over one handshake, which stays unanswered (like a handshake on a dead
   * connection) until the entry calls the `answer` it was given.
   */
  const handshakeHolds: Array<(answer: () => void) => void> = []

  beforeEach(async () => {
    const allowRequest = (
      req: http.IncomingMessage,
      cb: (err: string | null | undefined, allowed: boolean) => void,
    ) => {
      const allow = allowRequestFilters.every(f => f(req))
      const hold = handshakeHolds.shift()
      if (hold) {
        hold(() => cb(null, allow))
      } else {
        cb(null, allow)
      }
    }

    httpServer = http.createServer()
    nydusServer = nydus(httpServer, { allowRequest })
    nydusServer.registerRoute('/hello', helloHandler)
    nydusServer.registerRoute('/errorMe', errorMeHandler)

    port = await new Promise(resolve => {
      httpServer?.listen(0, () => {
        resolve((httpServer!.address() as AddressInfo).port)
      })
    })
  })

  afterEach(() => {
    for (const c of clients) {
      c.disconnect()
    }
    nydusServer?.close()
    httpServer?.close()

    allowRequestFilters.length = 0
    handshakeHolds.length = 0
    clients.length = 0
    nydusServer = undefined
    httpServer = undefined
  })

  async function connectClient(
    fn?: (client: NydusClient) => void | Promise<void>,
  ): Promise<NydusClient> {
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 2,
      reconnectionJitter: 0,
      connectTimeout: 30,
      transports: ['polling', 'websocket'],
    })
    clients.push(c)
    if (fn) await Promise.resolve().then(() => fn(c))
    const p = new Promise<NydusClient>((resolve, reject) => {
      c.once('connect', () => resolve(c)).once('error', err => reject(err))
    })
    c.connect()
    return await p
  }

  it('should connect to a server', async () => {
    return await connectClient()
  })

  it('should disconnect from a server', async () => {
    const sDisc = new Promise<void>(resolve => {
      nydusServer!.on('connection', c => {
        c.on('close', () => resolve())
      })
    })
    const c = await connectClient()
    const cDisc = new Promise<void>(resolve => c.on('disconnect', () => resolve()))

    c.disconnect()
    return await Promise.all([sDisc, cDisc])
  })

  it('should support INVOKEing server methods', async () => {
    const c = await connectClient()

    const response = await c.invoke('/hello')
    expect(response).to.be.eql('hi')
  })

  it('should support errors from INVOKE', async () => {
    const c = await connectClient()

    try {
      await c.invoke('/errorMe')
      return Promise.reject(new Error('should have thrown'))
    } catch (err: any) {
      expect(err).to.be.an.instanceOf(Error)
      expect(err.status).to.be.eql(420)
      expect(err.message).to.be.eql('Ya done goofed')
      return Promise.resolve()
    }
  })

  it('should reject INVOKEs with error data that is null or missing', async () => {
    // A server's invokeErrorConverter may return anything, including nothing
    const convertedServer = http.createServer()
    const converted = nydus(convertedServer, {
      invokeErrorConverter: (err: Error) => (err.message === 'null' ? null : undefined),
    } as any)
    converted.registerRoute('/null', async () => {
      throw new Error('null')
    })
    converted.registerRoute('/undefined', async () => {
      throw new Error('undefined')
    })
    const convertedPort = await new Promise<number>(resolve => {
      convertedServer.listen(0, () => resolve((convertedServer.address() as AddressInfo).port))
    })

    try {
      const c = client('ws://localhost:' + convertedPort)
      clients.push(c)
      await new Promise<void>(resolve => {
        c.once('connect', () => resolve())
        c.connect()
      })

      await expect(c.invoke('/null')).to.be.rejected.and.eventually.be.null
      await expect(c.invoke('/undefined')).to.be.rejected.and.eventually.be.undefined
    } finally {
      converted.close()
      convertedServer.close()
    }
  })

  it('should fail INVOKEs that happen while not connected', async () => {
    const c = client('ws://localhost:' + port)
    try {
      await c.invoke('/hello')
      return Promise.reject(new Error('should have thrown'))
    } catch (err: any) {
      expect(err).to.be.an.instanceOf(Error)
      expect(err.message).to.be.eql('Not connected')
      return Promise.resolve()
    }
  })

  it('should support registering for PUBLISHes', async () => {
    nydusServer!.on('connection', sC => {
      nydusServer!.subscribeClient(sC, '/publishes/whoever/splatsplatsplat')
    })

    const c = await connectClient()
    const p = new Promise<{ route: RouteInfo; data: any }>(resolve => {
      c.registerRoute('/publishes/:name/*', (route, data) => resolve({ route, data }))
    })

    nydusServer!.publish('/publishes/whoever/splatsplatsplat', { awesome: true })
    const { route, data } = await p

    expect(route).to.be.eql({
      route: '/publishes/:name/*',
      params: { name: 'whoever' },
      splats: ['splatsplatsplat'],
    })
    expect(data).to.be.eql({ awesome: true })
  })

  it("should emit 'unhandled' events when a PUBLISH goes unhandled", async () => {
    nydusServer!.on('connection', sC => {
      nydusServer!.subscribeClient(sC, '/publishes/whoever/splatsplatsplat')
    })
    const c = await connectClient()
    const p = new Promise<{ path: string; data: any }>(resolve => {
      c.once('unhandled', unhandled => resolve(unhandled))
    })

    nydusServer!.publish('/publishes/whoever/splatsplatsplat', { awesome: false })
    const { path, data } = await p

    expect(path).to.be.eql('/publishes/whoever/splatsplatsplat')
    expect(data).to.be.eql({ awesome: false })
  })

  it('should attempt reconnects on failed connections', async () => {
    const c = await connectClient()
    const p = new Promise((resolve, reject) => {
      c.once('reconnecting', attempt => resolve(attempt))
    })

    const p2 = p.then(
      attempt1 =>
        new Promise(resolve => {
          c.once('reconnecting', attempt2 => resolve([attempt1, attempt2]))
        }),
    )

    nydusServer!.close()
    httpServer!.close()
    const attempts = await p2

    expect(attempts).to.be.eql([1, 2])
  })

  it('should handle extremely quick disconnect -> connect calls', async () => {
    return await connectClient(async c => {
      const p = new Promise<void>(resolve => {
        allowRequestFilters.push(() => {
          c.disconnect()
          resolve()
          return true
        })
      })
      c.connect()
      await p
      allowRequestFilters.length = 0
    })
  })

  it('should emit unauthorized and not reconnect on 403 response', async () => {
    // Set up the filter to block requests (triggers 403)
    allowRequestFilters.push(() => false)

    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 10,
      reconnectionJitter: 0,
      connectTimeout: 30,
      transports: ['polling', 'websocket'],
    })
    clients.push(c)

    const unauthorizedPromise = new Promise<void>(resolve => {
      c.once('unauthorized', () => resolve())
    })

    const reconnectingPromise = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      unauthorizedPromise.then(() => {
        timeout = setTimeout(() => resolve(), 20) // Wait 20ms to see if reconnect happens
      })
      c.once('reconnecting', () => {
        reject(new Error('Should not attempt to reconnect after unauthorized'))
        if (timeout) {
          clearTimeout(timeout)
        }
      })
    })

    c.connect()

    await unauthorizedPromise
    await reconnectingPromise
  })

  it('should connect again when an unauthorized listener calls connect()', async () => {
    let authorized = false
    allowRequestFilters.push(() => authorized)
    const c = client('ws://localhost:' + port, {
      reconnectionJitter: 0,
      transports: ['polling', 'websocket'],
    })
    clients.push(c)
    c.once('unauthorized', () => {
      authorized = true
      c.connect()
    })

    const connected = new Promise<void>(resolve => c.once('connect', () => resolve()))
    c.connect()
    await connected
  })

  /** Holds the next handshake unanswered, returning a function that answers it. */
  function holdNextHandshake(): Promise<() => void> {
    return new Promise(resolve => {
      handshakeHolds.push(answer => resolve(answer))
    })
  }

  function createTimeoutClient(): NydusClient {
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 2,
      reconnectionJitter: 0,
      connectTimeout: 30,
      transports: ['polling', 'websocket'],
    })
    clients.push(c)
    return c
  }

  it('should retry past a stuck handshake with an INVOKE queued on it', async () => {
    const c = createTimeoutClient()
    const held = holdNextHandshake()
    let connects = 0
    const connected = new Promise<void>(resolve => {
      c.on('connect', () => {
        connects += 1
        resolve()
      })
    })

    c.connect()
    const queued = c.invoke('/hello')
    const answerStuck = await held

    await expect(queued).to.be.rejectedWith('Connection closed (connect timeout)')
    await connected

    // The stuck handshake completing late must not disturb the connection that replaced it
    answerStuck()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connects).to.be.eql(1)
    expect(await c.invoke('/hello')).to.be.eql('hi')
  })

  it('should disconnect during a stuck handshake with an INVOKE queued on it', async () => {
    const c = createTimeoutClient()
    const held = holdNextHandshake()
    let reconnecting = false
    c.on('reconnecting', () => {
      reconnecting = true
    })

    c.connect()
    const queued = c.invoke('/hello')
    const answerStuck = await held
    c.disconnect()

    await expect(queued).to.be.rejectedWith('Connection closed (forced close)')
    expect(c.readyState).to.be.eql('closed')
    // Outlasts the connect timeout, which must not revive reconnection after the disconnect
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(reconnecting).to.be.eql(false)

    answerStuck()
    const connected = new Promise<void>(resolve => c.once('connect', () => resolve()))
    c.connect()
    await connected
  })

  it('should not jitter reconnects when reconnectionJitter is 0', () => {
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 100,
      reconnectionDelayMax: 10000,
      reconnectionJitter: 0,
    })
    const backoff = (c as any).backoff
    const random = Math.random
    Math.random = () => 0.99
    try {
      expect([backoff.duration(), backoff.duration(), backoff.duration()]).to.be.eql([
        100, 200, 400,
      ])
    } finally {
      Math.random = random
    }
  })

  it('should not report a connection disconnected during its handshake as failed', async () => {
    const c = createTimeoutClient()
    const held = holdNextHandshake()
    let failures = 0
    c.on('connect_failed', () => {
      failures += 1
    })

    c.connect()
    const answerStuck = await held
    try {
      c.disconnect()
      await new Promise(resolve => setImmediate(resolve))
      expect(failures).to.be.eql(0)
    } finally {
      answerStuck()
    }
  })

  it('should treat a disconnect from a connect_timeout listener as cancelling', async () => {
    const c = createTimeoutClient()
    const held = holdNextHandshake()
    let failures = 0
    c.on('connect_failed', () => {
      failures += 1
    })
    const timedOut = new Promise<void>(resolve =>
      c.once('connect_timeout', () => {
        c.disconnect()
        resolve()
      }),
    )

    c.connect()
    const answerStuck = await held
    try {
      await timedOut
      await new Promise(resolve => setImmediate(resolve))
      expect(failures).to.be.eql(0)
    } finally {
      answerStuck()
    }
  })

  it('should not emit reconnecting after connect() supersedes a pending reconnect', async () => {
    let serverClient: { close(): void } | undefined
    nydusServer!.on('connection', sC => {
      serverClient = sC
    })
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 50,
      reconnectionJitter: 0,
      transports: ['polling', 'websocket'],
    })
    clients.push(c)
    await new Promise<void>(resolve => {
      c.once('connect', () => resolve())
      c.connect()
    })

    const disconnected = new Promise<void>(resolve => c.once('disconnect', () => resolve()))
    serverClient!.close()
    await disconnected
    // The disconnect has scheduled a reconnect; connect before it fires
    await new Promise(resolve => setImmediate(resolve))
    let reconnecting = 0
    c.on('reconnecting', () => {
      reconnecting += 1
    })
    const connected = new Promise<void>(resolve => c.once('connect', () => resolve()))
    c.connect()
    await connected

    // Outlasts the superseded reconnect's delay
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(reconnecting).to.be.eql(0)
  })

  it('should give connect() full reconnection attempts after a cancelled reconnect', async () => {
    // Nothing is listening, so every connection attempt fails
    nydusServer!.close()
    httpServer!.close()

    const c = client('ws://localhost:' + port, {
      reconnectionAttempts: 1,
      reconnectionDelay: 10,
      reconnectionJitter: 0,
      transports: ['polling'],
    })
    clients.push(c)

    const failed = new Promise<void>(resolve => c.once('connect_failed', () => resolve()))
    c.connect()
    await failed
    // The failure scheduled a reconnect, which this cancels before it was ever attempted
    await new Promise(resolve => setImmediate(resolve))
    c.disconnect()

    const events: string[] = []
    c.on('reconnecting', () => events.push('reconnecting'))
    const gaveUp = new Promise<void>(resolve =>
      c.once('reconnect_failed', () => {
        events.push('reconnect_failed')
        resolve()
      }),
    )
    c.connect()
    await gaveUp

    expect(events).to.be.eql(['reconnecting', 'reconnect_failed'])
  })

  it('should reject outstanding INVOKEs when the connection closes', async () => {
    nydusServer!.registerRoute('/never', () => new Promise(() => {}))
    const c = await connectClient()

    const outstanding = c.invoke('/never')
    c.disconnect()

    await expect(outstanding).to.be.rejectedWith('Connection closed (forced close)')
  })

  /**
   * Connects a polling-only client and leaves an INVOKE being written, so a close has to wait for
   * that write to finish (leaving the socket 'closing' meanwhile).
   */
  async function connectWithWriteInFlight(): Promise<NydusClient> {
    nydusServer!.registerRoute('/never', () => new Promise(() => {}))
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 2,
      reconnectionJitter: 0,
      transports: ['polling'],
    })
    clients.push(c)
    await new Promise<void>(resolve => {
      c.once('connect', () => resolve())
      c.connect()
    })
    c.invoke('/never').catch(() => {})
    return c
  }

  it('should connect again after a socket closed by a bad message finishes closing', async () => {
    const c = await connectWithWriteInFlight()
    // As if the server sent something unparseable, which makes the client close the socket
    ;(c.conn as any).emit('message', 'not a nydus message')
    expect(c.readyState).to.be.eql('closing')

    const reconnected = new Promise<void>(resolve => c.once('connect', () => resolve()))
    c.connect()
    await reconnected
  })

  it('should stay disconnected after a connect() made while closing is disconnected', async () => {
    const c = await connectWithWriteInFlight()
    c.disconnect()
    expect(c.readyState).to.be.eql('closing')
    c.connect()
    c.disconnect()

    let connects = 0
    c.on('connect', () => {
      connects += 1
    })
    await new Promise<void>(resolve => c.once('disconnect', () => resolve()))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connects).to.be.eql(0)
    expect(c.readyState).to.be.eql('closed')
  })

  it('should stop connecting to a server with an incompatible protocol version', async () => {
    const c = await connectClient()
    const errors: string[] = []
    c.on('error', err => errors.push(err.message))
    let reconnecting = false
    c.on('reconnecting', () => {
      reconnecting = true
    })
    const disconnected = new Promise<void>(resolve => c.once('disconnect', () => resolve()))

    // As if the server welcomed the client with a protocol version it doesn't speak
    ;(c.conn as any).emit('message', `0|${protocolVersion + 1}`)
    await disconnected
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(errors).to.be.eql([
      `Server has incompatible protocol version: ${protocolVersion + 1} ` +
        `(expected ${protocolVersion})`,
    ])
    expect(reconnecting).to.be.eql(false)
    expect(c.readyState).to.be.eql('closed')
  })

  it('should report every response to an INVOKE after the first as an error', async () => {
    nydusServer!.registerRoute('/never', () => new Promise(() => {}))
    const c = await connectClient()
    const conn = c.conn as any
    const sent: string[] = []
    const send = conn.send.bind(conn)
    conn.send = (msg: string, opts: unknown) => {
      sent.push(msg)
      send(msg, opts)
    }
    const errors: string[] = []
    c.on('error', err => errors.push(err.message))

    const result = c.invoke('/never')
    const { id } = decode(sent[0]) as { id: string }
    // As if the server answered twice in one payload, and then once more later
    conn.emit('message', encode(MessageType.Result, 'first', id))
    conn.emit('message', encode(MessageType.Result, 'second', id))
    expect(await result).to.be.eql('first')
    conn.emit('message', encode(MessageType.Result, 'third', id))

    expect(errors).to.be.eql(['Unknown invoke id', 'Unknown invoke id'])
  })
})
