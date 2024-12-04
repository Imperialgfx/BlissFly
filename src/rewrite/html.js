class BlissFlyRewriter {
    static transformHtml(html, baseUrl) {
        // Add meta injection
        const meta = {
            url: baseUrl,
            base: new URL(baseUrl).origin,
        };

        // Inject BlissFly client
        const clientScript = `
            <script>
                window.__blissfly = {
                    meta: ${JSON.stringify(meta)}
                };
            </script>
        `;

        // Transform URLs and inject client
        return html
            .replace('</head>', `${clientScript}</head>`)
            .replace(/(?<=<(?:a|link|img|script|iframe|source|embed).*?(?:href|src)=["'])(.*?)(?=["'])/g, 
                (_, url) => this.rewriteUrl(url, baseUrl));
    }

    static rewriteUrl(url, base) {
        try {
            const absolute = new URL(url, base).href;
            return '/watch?url=' + btoa(encodeURIComponent(absolute));
        } catch(e) {
            return url;
        }
    }
}

module.exports = BlissFlyRewriter;
