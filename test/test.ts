import * as chai from 'chai'
import { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import { AddressInfo } from 'net'

import nydus, { NydusServer } from 'nydus'
import client, { InvokeError, NydusClient, RouteInfo } from '../index.js'

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

  it('should reject outstanding INVOKEs when the connection closes', async () => {
    nydusServer!.registerRoute('/never', () => new Promise(() => {}))
    const c = await connectClient()

    const outstanding = c.invoke('/never')
    c.disconnect()

    await expect(outstanding).to.be.rejectedWith('Connection closed (forced close)')
  })
})
