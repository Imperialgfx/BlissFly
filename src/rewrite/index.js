const BlissFlyRewriter = require('./html.js');

const rewriter = {
    rewriteHTML: (html, baseUrl) => {
        return BlissFlyRewriter.transformHtml(html, baseUrl);
    },
    rewriteJS: (js, baseUrl) => {
        return BlissFlyRewriter.transformJavaScript(js, baseUrl);
    },
    rewriteCSS: (css, baseUrl) => {
        return BlissFlyRewriter.transformCss(css, baseUrl);
    }
};

module.exports = rewriter;
