const parse5 = require('parse5');
const { URL } = require('url');

class BlissFlyBundle {
    constructor(ctx) {
        this.ctx = ctx;
        this.html = new HTMLRewriter(ctx);
        this.css = new CSSRewriter(ctx);
        this.js = new JSRewriter(ctx);
        this.fetch = new FetchInterceptor(ctx);
        this.meta = {
            origin: null,
            base: null,
            url: null
        };
    }

    async rewriteHtml(html, baseUrl) {
        this.meta.url = baseUrl;
        this.meta.base = new URL(baseUrl).origin;
        const document = parse5.parse(html);
        await this.injectScripts(document);
        const rewrittenHtml = await this.html.rewrite(document);
        return parse5.serialize(rewrittenHtml);
    }

    async injectScripts(document) {
        const head = document.childNodes.find(node => node.tagName === 'head');
        if (head) {
            const script = parse5.parseFragment(`
                <script>
                    window.__bf = {
                        prefix: '${this.ctx.prefix}',
                        meta: ${JSON.stringify(this.meta)},
                        codec: {
                            encode: ${this.ctx.codec.encode.toString()},
                            decode: ${this.ctx.codec.decode.toString()}
                        }
                    };
                </script>
            `);
            head.childNodes.unshift(script);
        }
    }

    rewriteCss(css, baseUrl) {
        return this.css.rewrite(css, baseUrl);
    }

    rewriteJs(js) {
        return this.js.rewrite(js);
    }
}

class HTMLRewriter {
    constructor(ctx) {
        this.ctx = ctx;
        this.js = new JSRewriter(ctx);
        this.css = new CSSRewriter(ctx);
    }

    async rewrite(document) {
        await this.rewriteNode(document);
        return document;
    }

    async rewriteNode(node) {
        if (node.tagName) {
            await this.rewriteElement(node);
        }
        if (node.childNodes) {
            for (const child of node.childNodes) {
                await this.rewriteNode(child);
            }
        }
    }

    async rewriteElement(element) {
        if (!element.attrs) return;

        const rewriteAttrs = ['src', 'href', 'action', 'srcset', 'data', 'poster'];
        
        for (const attr of element.attrs) {
            if (rewriteAttrs.includes(attr.name)) {
                if (attr.name === 'srcset') {
                    attr.value = this.rewriteSrcset(attr.value);
                } else if (attr.value && !attr.value.startsWith('data:')) {
                    attr.value = this.ctx.rewriteUrl(attr.value);
                }
            }
        }

        if (element.tagName === 'script') {
            await this.rewriteScript(element);
        }
        if (element.tagName === 'style') {
            await this.rewriteStyle(element);
        }
    }

    rewriteSrcset(srcset) {
        return srcset.split(',').map(src => {
            const [url, size] = src.trim().split(' ');
            return `${this.ctx.rewriteUrl(url)} ${size || ''}`;
        }).join(', ');
    }

    async rewriteScript(element) {
        if (element.childNodes && element.childNodes[0]) {
            const content = element.childNodes[0].value;
            element.childNodes[0].value = this.js.rewrite(content);
        }
    }

    async rewriteStyle(element) {
        if (element.childNodes && element.childNodes[0]) {
            const content = element.childNodes[0].value;
            element.childNodes[0].value = this.css.rewrite(content);
        }
    }
}

class CSSRewriter {
    constructor(ctx) {
        this.ctx = ctx;
    }

    rewrite(css, baseUrl) {
        return css
            .replace(/url\(['"]?(.*?)['"]?\)/g, (match, url) => {
                if (!url.startsWith('data:')) {
                    return `url("${this.ctx.rewriteUrl(url)}")`;
                }
                return match;
            })
            .replace(/@import\s+['"]([^'"]+)['"]/g, (match, url) => {
                return `@import "${this.ctx.rewriteUrl(url)}"`;
            });
    }
}

class JSRewriter {
    constructor(ctx) {
        this.ctx = ctx;
    }

    rewrite(js) {
        if (!js) return '';
        return js
            .replace(/location\s*=\s*(['"])(.*?)\1/g, 
                (match, quote, url) => `location = ${quote}${this.ctx.rewriteUrl(url)}${quote}`)
            .replace(/\b(location|document|window)\b/g, '__bf.$1')
            .replace(/\blocation\b/g, '__bf.location');
    }
}

module.exports = { BlissFlyBundle, HTMLRewriter, CSSRewriter, JSRewriter };
