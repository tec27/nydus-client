# nydus-client

WebSocket client library for the [nydus protocol](https://github.com/tec27/nydus-protocol), a simple RPC/PubSub protocol.

[![Build Status](https://img.shields.io/travis/tec27/nydus-client.svg?style=flat)](https://travis-ci.org/tec27/nydus-client)
[![NPM](https://img.shields.io/npm/v/nydus-client.svg?style=flat)](https://www.npmjs.org/package/nydus-client)

[![NPM](https://nodei.co/npm/nydus-client.png)](https://nodei.co/npm/nydus-client/)

## Usage
#### `import nydusClient from 'nydus-client'`

<b><code>const socket = nydusClient(host[, options])</code></b>

Create a nydus client and connect it to a particular `host`. An optional `options` object can be
passed as the second argument.
For the list of acceptable options, check the [constructor method](https://github.com/socketio/engine.io-client#methods) of engine.io-client.

## API

<b><code>socket.connect()</code></b>

Connect to the server. If already connected, this will be a no-op.

<b><code>socket.registerRoute(pathPattern, handler)</code></b>

Register a handler function to respond to `PUBLISH` messages on a path matching the specified
pattern. Handler function is a normal function of the form:
`function({ route, params, splats }, data)`

`PUBLISH` messages that don't match a route will be emitted as an 'unhandled' event on this object,
which can be useful to track in development mode.

<b><code>socket.invoke(path[, data])</code></b>

Invoke a remote method on the server, specified via a path. Optionally, data can be specified to
send along with the call (will be JSON encoded). A Promise will be returned; resolved or rejected
with the result or error, respectively, from the server.

<b><code>socket.disconnect()</code></b>

Disconnect from the server. If not already connected, this will be a no-op.

## License

MIT
