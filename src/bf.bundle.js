const parse5 = require('parse5');

class BlissFlyBundle {
    constructor(ctx) {
        this.ctx = ctx;
        this.html = new HTMLRewriter(ctx);
        this.css = new CSSRewriter(ctx);
        this.js = new JSRewriter(ctx);
    }

    async rewriteHtml(html, baseUrl) {
        const document = parse5.parse(html);
        const rewrittenHtml = await this.html.rewrite(document, baseUrl);
        return parse5.serialize(rewrittenHtml);
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
    }

    async rewrite(document, baseUrl) {
        await this.rewriteNode(document, baseUrl);
        return document;
    }

    async rewriteNode(node, baseUrl) {
        if (node.tagName) {
            await this.rewriteElement(node, baseUrl);
        }
        if (node.childNodes) {
            for (const child of node.childNodes) {
                await this.rewriteNode(child, baseUrl);
            }
        }
    }

    async rewriteElement(element, baseUrl) {
        if (!element.attrs) return;

        for (const attr of element.attrs) {
            if (this.shouldRewriteAttr(attr.name)) {
                attr.value = this.ctx.rewriteUrl(new URL(attr.value, baseUrl).href);
            }
        }

        if (element.tagName === 'script') {
            await this.rewriteScript(element);
        }
    }

    shouldRewriteAttr(attr) {
        return ['src', 'href', 'action'].includes(attr);
    }

    async rewriteScript(element) {
        if (element.childNodes && element.childNodes[0]) {
            const content = element.childNodes[0].value;
            element.childNodes[0].value = this.js.rewrite(content);
        }
    }
}

class CSSRewriter {
    constructor(ctx) {
        this.ctx = ctx;
    }

    rewrite(css, baseUrl) {
        return css.replace(/url\(['"]?(.*?)['"]?\)/g, (match, url) => {
            if (!url.startsWith('data:')) {
                const absoluteUrl = new URL(url, baseUrl).href;
                return `url("${this.ctx.rewriteUrl(absoluteUrl)}")`;
            }
            return match;
        });
    }
}

class JSRewriter {
    constructor(ctx) {
        this.ctx = ctx;
    }

    rewrite(js) {
        // Basic JS rewriting logic
        if (!js) return '';
        return js.replace(/((?:(?:window|document|location)\.[a-zA-Z_$][a-zA-Z0-9_$]*)|(?:location))/g, 
            match => `__bf.${match}`);
    }
}

module.exports = { BlissFlyBundle, HTMLRewriter, CSSRewriter, JSRewriter };
