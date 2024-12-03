const { EventEmitter } = require('events');
const { URL } = require('url');
const { Buffer } = require('buffer');

class BlissFlyClient extends EventEmitter {
    constructor(window = global, bareClient, worker = false) {
        super();
        this.window = window;
        this.codec = {
            encode: (url) => {
                return Buffer.from(url).toString('base64');
            },
            decode: (encoded) => {
                return Buffer.from(encoded, 'base64').toString();
            }
        };
        this.prefix = '/service/';
        this.nativeMethods = {
            fnToString: Function.prototype.toString,
            defineProperty: Object.defineProperty,
            getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
            getOwnPropertyNames: Object.getOwnPropertyNames,
            keys: Object.keys,
            getOwnPropertySymbols: Object.getOwnPropertySymbols,
            isArray: Array.isArray,
            setPrototypeOf: Object.setPrototypeOf,
            isExtensible: Object.isExtensible,
            Map: Map
        };
        this.worker = worker;
        this.bareClient = bareClient;
        this.location = new LocationApi(this);
        this.document = new DocumentApi(this);
        this.element = new ElementApi(this);
        this.style = new StyleApi(this);
    }

    rewriteUrl(url) {
        return this.prefix + this.codec.encode(url);
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
    }
}

class DocumentApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Document = {};
        this.docProto = {};
        this.title = "";
        this.referrer = "";
    }
}

class ElementApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Element = {};
        this.elemProto = {};
        this.innerHTML = "";
        this.outerHTML = "";
    }
}

class StyleApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.CSSStyleDeclaration = {};
        this.cssStyleProto = {};
        this.getPropertyValue = () => {};
        this.setProperty = () => {};
    }
}

module.exports = { BlissFlyClient, LocationApi, DocumentApi, ElementApi, StyleApi };
