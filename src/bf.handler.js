class BlissFlyClient extends EventEmitter {
    constructor(window = self, bareClient, worker = !window.window) {
        super();
        this.window = window;
        this.nativeMethods = {
            fnToString: this.window.Function.prototype.toString,
            defineProperty: this.window.Object.defineProperty,
            getOwnPropertyDescriptor: this.window.Object.getOwnPropertyDescriptor,
            getOwnPropertyNames: this.window.Object.getOwnPropertyNames,
            keys: this.window.Object.keys,
            getOwnPropertySymbols: this.window.Object.getOwnPropertySymbols,
            isArray: this.window.Array.isArray,
            setPrototypeOf: this.window.Object.setPrototypeOf,
            isExtensible: this.window.Object.isExtensible,
            Map: this.window.Map
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

class DocumentApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Document = this.window.Document;
        this.docProto = this.Document.prototype;
        this.title = bf.nativeMethods.getOwnPropertyDescriptor(this.docProto, "title");
        this.referrer = bf.nativeMethods.getOwnPropertyDescriptor(this.docProto, "referrer");
    }
}

class ElementApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.Element = this.window.Element;
        this.elemProto = this.Element.prototype;
        this.innerHTML = bf.nativeMethods.getOwnPropertyDescriptor(this.elemProto, "innerHTML");
        this.outerHTML = bf.nativeMethods.getOwnPropertyDescriptor(this.elemProto, "outerHTML");
    }
}

class StyleApi {
    constructor(bf) {
        this.bf = bf;
        this.window = bf.window;
        this.CSSStyleDeclaration = this.window.CSSStyleDeclaration;
        this.cssStyleProto = this.CSSStyleDeclaration.prototype;
        this.getPropertyValue = this.cssStyleProto.getPropertyValue;
        this.setProperty = this.cssStyleProto.setProperty;
    }
}
