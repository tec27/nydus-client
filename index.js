var Socket = require('./socket')
  , EventEmitter = require('events').EventEmitter
  , inherits = require('inherits')
  , protocol = require('nydus-protocol')
  , idgen = require('idgen')

module.exports = function(host) {
  return new NydusClient(host)
}

NydusClient.WELCOME_TIMEOUT = 25000

function NydusClient(host) {
  EventEmitter.call(this)
  this.socket = new Socket(host)
  this.socket.open()
  this.readyState = 'connecting'

  this._outstandingCalls = Object.create(null)

  this.socket.on('connect', this._onConnect.bind(this))
    .on('disconnect', this._onDisconnect.bind(this))
    .on('error', this._onError.bind(this))
    .on('message:call', this._onCallMessage.bind(this))
    .on('message:result', this._onResultMessage.bind(this))
    .on('message:error', this._onErrorMessage.bind(this))
    .on('message:subscribe', this._onSubscribeMessage.bind(this))
    .on('message:unsubscribe', this._onUnsubscribeMessage.bind(this))
    .on('message:publish', this._onPublishMessage.bind(this))
    .on('message:event', this._onEventMessage.bind(this))

}
inherits(NydusClient, EventEmitter)

// call('/my/path', params..., function(err, results...) { })
NydusClient.prototype.call = function(path, params, cb) {
  if (this.readyState != 'connected') {
    var args = arguments
      , self = this
    this.once('connect', function() {
      self.call.apply(self, args)
    })
    return
  }

  var message = { type: protocol.CALL
                , callId: this._getCallId()
                , procPath: path
                }
    , callback = arguments.length > 1 ? arguments[arguments.length - 1] : function() {}
    , callParams = Array.prototype.slice.call(arguments, 1, arguments.length - 1)
  if (typeof callback != 'function') {
    callback = function() {}
    callParams.push(arguments[arguments.length - 1])
  }
  message.params = callParams
  this._outstandingCalls[message.callId] = callback
  this.socket.sendMessage(message)
}

NydusClient.prototype._getCallId = function() {
  var id
  do {
    id = idgen(16)
  } while (this._outstandingCalls[id])
  return id
}

NydusClient.prototype._onConnect = function() {
  var self = this
  this.socket.once('message:welcome', onWelcome)
    .once('disconnect', onDisconnect)

  var timeout = setTimeout(function() {
    self.socket.removeListener('message:welcome', onWelcome)
    self.socket.close()
    self.emit('error', new Error('Server did not send a WELCOME on connect'))
  }, NydusClient.WELCOME_TIMEOUT)

  function onWelcome(message) {
    clearTimeout(timeout)
    self.socket.removeListener('disconnect', onDisconnect)
    if (message.protocolVersion != protocol.protocolVersion) {
      self.socket.close()
      self.emit('error', new Error('Server is using an unsupported protocol version: ' +
          message.protocolVersion))
    } else {
      self.readyState = 'connected'
      self.emit('connect')
    }
  }

  function onDisconnect(message) {
    clearTimeout(timeout)
    self.socket.removeListener('message:welcome')
  }
}

NydusClient.prototype._onError = function(err) {
  this.emit('error', err)
}

NydusClient.prototype._onDisconnect = function() {
  this.readyState = 'disconnected'
  this.emit('disconnect')
}

NydusClient.prototype._onCallMessage = function(message) {
  
}

NydusClient.prototype._onResultMessage = function(message) {
  var cb = this._outstandingCalls[message.callId]
  if (!cb) {
    return this.emit('error',
      new Error('Received a result for an unrecognized callId: ' + message.callId))
  }
  delete this._outstandingCalls[message.callId]

  var results = [ null /* err */ ].concat(message.results)
  cb.apply(this, results)
}

NydusClient.prototype._onErrorMessage = function(message) {
  var cb = this._outstandingCalls[message.callId]
  if (!cb) {
    return this.emit('error',
      new Error('Received an error for an unrecognized callId: ' + message.callId))
  }
  delete this._outstandingCalls[message.callId]

  var err = { code: message.errorCode
            , desc: message.errorDesc
            , details: message.errorDetails
            }
  cb.call(this, err)
}

NydusClient.prototype._onSubscribeMessage = function(message) {

}

NydusClient.prototype._onUnsubscribeMessage = function(message) {

}

NydusClient.prototype._onPublishMessage = function(message) {

}

NydusClient.prototype._onEventMessage = function(message) {

}
