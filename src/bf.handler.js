const { EventEmitter } = require('events');
const { URL } = require('url');
const { Buffer } = require('buffer');

class BlissFlyClient extends EventEmitter {
    constructor(window = global, bareClient, worker = false) {
        super();
        this.window = window;
        this.meta = {
            url: null,
            base: null,
            encoding: null,
        };
        this.codec = {
            encode: (url) => {
                if (!url.startsWith('http:') && !url.startsWith('https:')) {
                    return url;
                }
                return Buffer.from(url).toString('base64');
            },
            decode: (encoded) => {
                try {
                    return Buffer.from(encoded, 'base64').toString();
                } catch {
                    return encoded;
                }
            }
        };
        this.prefix = '/service/';
        this.bareClient = bareClient;
        this.location = new LocationApi(this);
        this.document = new DocumentApi(this);
        this.element = new ElementApi(this);
        this.style = new StyleApi(this);
        this.fetch = new FetchApi(this);
        this.xhr = new XhrApi(this);
        this.websocket = new WebSocketApi(this);
    }

    rewriteUrl(url) {
        try {
            const parsed = new URL(url, this.meta.url);
            return this.prefix + this.codec.encode(parsed.toString());
        } catch {
            return url;
        }
    }

    sourceUrl(url) {
        return this.codec.decode(url.slice(this.prefix.length));
    }
}

class LocationApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.location = this.window.location || {};
        this.emitter = new EventEmitter();
    }

    overrideLocation() {
        const descriptors = {
            href: {
                get: () => this.bf.sourceUrl(this.location.href),
                set: (val) => this.location.href = this.bf.rewriteUrl(val)
            },
            origin: {
                get: () => new URL(this.bf.sourceUrl(this.location.href)).origin
            }
        };
        
        Object.defineProperties(this.location, descriptors);
    }
}

class DocumentApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Document = this.window.Document || {};
        this.docProto = this.Document.prototype || {};
    }

    overrideDocument() {
        const descriptors = {
            domain: {
                get: () => new URL(this.bf.sourceUrl(this.window.location.href)).hostname,
                set: () => {}
            },
            referrer: {
                get: () => this.bf.sourceUrl(this.window.document.referrer)
            }
        };

        Object.defineProperties(this.docProto, descriptors);
    }
}

class ElementApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Element = this.window.Element || {};
        this.elemProto = this.Element.prototype || {};
    }

    overrideElement() {
        const urlAttributes = ['src', 'href', 'action', 'srcset'];
        
        for (const attr of urlAttributes) {
            const descriptor = Object.getOwnPropertyDescriptor(this.elemProto, attr);
            if (descriptor) {
                Object.defineProperty(this.elemProto, attr, {
                    get: () => this.bf.sourceUrl(descriptor.get.call(this)),
                    set: (val) => descriptor.set.call(this, this.bf.rewriteUrl(val))
                });
            }
        }
    }
}

class StyleApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.CSSStyleDeclaration = this.window.CSSStyleDeclaration || {};
        this.cssStyleProto = this.CSSStyleDeclaration.prototype || {};
    }

    rewriteStyle(css) {
        return css.replace(/url\(['"]?(.*?)['"]?\)/g, (match, url) => {
            if (!url.startsWith('data:')) {
                return `url("${this.bf.rewriteUrl(url)}")`;
            }
            return match;
        });
    }
}

class FetchApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
    }

    overrideFetch() {
        const originalFetch = this.window.fetch;
        this.window.fetch = async (url, options = {}) => {
            if (typeof url === 'string') {
                url = this.bf.rewriteUrl(url);
            }
            return originalFetch(url, options);
        };
    }
}

class XhrApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
    }

    overrideXhr() {
        const XHR = this.window.XMLHttpRequest;
        const originalOpen = XHR.prototype.open;
        
        XHR.prototype.open = function(method, url, ...args) {
            url = this.bf.rewriteUrl(url);
            return originalOpen.call(this, method, url, ...args);
        };
    }
}

class WebSocketApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
    }

    overrideWebSocket() {
        const WS = this.window.WebSocket;
        this.window.WebSocket = function(url, ...args) {
            url = this.bf.rewriteUrl(url);
            return new WS(url, ...args);
        };
    }
}

module.exports = { 
    BlissFlyClient,
    LocationApi,
    DocumentApi,
    ElementApi,
    StyleApi,
    FetchApi,
    XhrApi,
    WebSocketApi
};
