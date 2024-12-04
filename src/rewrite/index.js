const BlissFlyRewriter = require('./html.js');

class ContentRewriter {
    constructor() {
        this.rewriter = BlissFlyRewriter;
    }

    rewriteHTML(html, baseUrl) {
        return this.rewriter.transformHtml(html, baseUrl);
    }
}

module.exports = ContentRewriter;
