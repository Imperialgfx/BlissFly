class BlissFlyWebSocket extends EventEmitter {
    constructor(ctx) {
        super();
        this.ctx = ctx;
        this.window = ctx.window;
        this.WebSocket = this.window.WebSocket || {};
        this.wsProto = this.WebSocket.prototype;
        this.socketMap = new WeakMap();
    }

    overrideWebSocket(client) {
        this.ctx.override(
            this.window,
            "WebSocket",
            (target, that, args) => {
                const fakeWS = new EventTarget();
                Object.setPrototypeOf(fakeWS, this.wsProto);
                const ws = client.createWebSocket(args[0], args[1], null, {
                    "User-Agent": navigator.userAgent,
                    Origin: location.origin,
                });
                this.socketMap.set(fakeWS, ws);
                return fakeWS;
            }
        );
    }
}
