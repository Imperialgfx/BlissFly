const EventEmitter = require('events');
const BlissFlyWebSocket = require('./websocket.js');
const HookEvent = require('./hook.js');

class BlissFlyClient extends EventEmitter {
    constructor(window, bareClient, worker) {
        super();
        this.window = window;
        this.worker = worker;
        this.bareClient = bareClient;
        this.websocket = new BlissFlyWebSocket(this);
    }

    createWebSocket(url, protocols) {
        return this.bareClient.createWebSocket(url, protocols);
    }
}

module.exports = BlissFlyClient;
