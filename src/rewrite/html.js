class BlissFlyRewriter {
    static async transformHtml(html, baseUrl) {
        // Add UV-style meta injection
        const meta = {
            url: baseUrl,
            base: new URL(baseUrl).origin,
            originalHtml: html,
        };

        // Inject BlissFly :)
        const clientScript = `
            <script>
                window.__blissfly = {
                    meta: ${JSON.stringify(meta)},
                    handler: ${this.handler.toString()},
                };
            </script>
        `;

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
