const BlissflyHandler = {
    config: {
        prefix: '/service/',
        handler: '/bf.handler.js',
        bundle: '/bf.bundle.js',
        config: '/bf.config.js',
        sw: '/bf.sw.js'
    },

    rewriteUrl(url) {
        return this.config.prefix + btoa(encodeURIComponent(url));
    },

    transformResponse(response, url) {
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('html')) {
            return this.transformHtml(response, url);
        } else if (contentType.includes('javascript')) {
            return this.transformJs(response);
        } else if (contentType.includes('css')) {
            return this.transformCss(response, url);
        }
        
        return response;
    },

    async transformHtml(response, baseUrl) {
        const html = await response.text();
        const injectedScript = `
            <script>
                window.__blissfly = {
                    baseUrl: "${baseUrl}",
                    prefix: "${this.config.prefix}"
                };
                
                // Intercept fetch requests
                const originalFetch = window.fetch;
                window.fetch = async function(url, options) {
                    if (url && !url.startsWith('data:')) {
                        url = '/service/' + btoa(encodeURIComponent(url));
                    }
                    return originalFetch(url, options);
                };
            </script>
        `;
        
        return html.replace('</head>', `${injectedScript}</head>`);
    }
};

module.exports = BlissflyHandler;
