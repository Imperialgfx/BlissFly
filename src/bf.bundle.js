class BlissFlyBundle {
    constructor(ctx) {
        this.ctx = ctx;
        this.html = new HTMLRewriter(ctx);
        this.css = new CSSRewriter(ctx);
        this.js = new JSRewriter(ctx);
    }

    rewriteHtml(html, baseUrl) {
        return this.html.rewrite(html, { ...this.ctx.meta, url: baseUrl });
    }

    rewriteCss(css, baseUrl) {
        return this.css.rewrite(css, { ...this.ctx.meta, url: baseUrl });
    }

    rewriteJs(js) {
        return this.js.rewrite(js, this.ctx.meta);
    }
}
