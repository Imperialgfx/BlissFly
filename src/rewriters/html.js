class HTMLRewriter {
    constructor(ctx) {
        this.ctx = ctx;
    }

    rewrite(html, meta = {}) {
        const dom = parse(html);
        this.rewriteNode(dom, meta);
        return serialize(dom);
    }

    rewriteNode(node, meta) {
        if (node.tagName) {
            this.rewriteElement(node, meta);
        }
        if (node.childNodes) {
            node.childNodes.forEach(child => this.rewriteNode(child, meta));
        }
    }

    rewriteElement(element, meta) {
        const { tagName } = element;
        if (tagName === 'script') {
            this.rewriteScript(element, meta);
        } else if (tagName === 'link') {
            this.rewriteLink(element, meta);
        } else if (tagName === 'style') {
            this.rewriteStyle(element, meta);
        }
    }
}
