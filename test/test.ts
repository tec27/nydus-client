import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import { AddressInfo } from 'net'

import nydus, { NydusServer } from 'nydus'
import client, { InvokeError, NydusClient, RouteInfo } from '../index'

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
  let clients: NydusClient[] = []

  beforeEach(async () => {
    httpServer = http.createServer()
    nydusServer = nydus(httpServer)
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

    clients = []
    nydusServer = undefined
    httpServer = undefined
  })

  async function connectClient(fn?: (client: NydusClient) => void): Promise<NydusClient> {
    const c = client('ws://localhost:' + port, {
      reconnectionDelay: 1,
      reconnectionJitter: 0,
      connectTimeout: 30,
      transports: ['websocket'],
    })
    clients.push(c)
    if (fn) fn(c)
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
    } catch (err) {
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
    } catch (err) {
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
})
