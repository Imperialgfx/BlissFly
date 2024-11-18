const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');

class CacheManager {
    constructor(maxSize = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    set(key, value, ttl = 300000) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        
        return item.value;
    }

    prune() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expiry) {
                this.cache.delete(key);
            }
        }
    }
}

const app = express();
const cache = new CacheManager(100);
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.15';

// Middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    res.set({
        'X-DNS-Prefetch-Control': 'on',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400'
    });
    next();
});

// URL encoding/decoding functions
function encodeUrl(url) {
    return Buffer.from(url).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function decodeUrl(encoded) {
    encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (encoded.length % 4) encoded += '=';
    return Buffer.from(encoded, 'base64').toString();
}

// Request handling functions
async function fetchWithRedirects(url, options = {}, maxRedirects = 10, retryCount = 3) {
    const cachedResponse = cache.get(url);
    if (cachedResponse) return cachedResponse;

    const visitedUrls = new Set();
    let lastError;

    for (let attempt = 0; attempt < retryCount; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const protocol = url.startsWith('https') ? https : http;
                const urlObj = new URL(url);

                function makeRequest(currentUrl, redirectCount = 0) {
                    if (visitedUrls.has(currentUrl.href)) {
                        reject(new Error('Circular redirect detected'));
                        return;
                    }
                    visitedUrls.add(currentUrl.href);

                    const requestOptions = {
                        hostname: currentUrl.hostname,
                        path: currentUrl.pathname + currentUrl.search,
                        method: options.method || 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                            'Sec-Fetch-Site': 'none',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-User': '?1',
                            'Sec-Fetch-Dest': 'document',
                            ...options.headers
                        },
                        timeout: 30000
                    };

                    const req = protocol.request(requestOptions, (response) => {
                        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                            if (redirectCount >= maxRedirects) {
                                reject(new Error(`Maximum redirects (${maxRedirects}) exceeded`));
                                return;
                            }
                            
                            try {
                                const nextUrl = new URL(response.headers.location, currentUrl);
                                makeRequest(nextUrl, redirectCount + 1);
                            } catch (e) {
                                reject(new Error('Invalid redirect URL'));
                            }
                            return;
                        }

                        let output;
                        switch (response.headers['content-encoding']) {
                            case 'br':
                                output = zlib.createBrotliDecompress();
                                response.pipe(output);
                                break;
                            case 'gzip':
                                output = zlib.createGunzip();
                                response.pipe(output);
                                break;
                            case 'deflate':
                                output = zlib.createInflate();
                                response.pipe(output);
                                break;
                            default:
                                output = response;
                                break;
                        }

                        const chunks = [];
                        output.on('data', chunk => chunks.push(chunk));
                        output.on('end', () => {
                            const result = {
                                data: Buffer.concat(chunks),
                                headers: response.headers,
                                statusCode: response.statusCode
                            };
                            
                            if (response.statusCode === 200) {
                                cache.set(url, result);
                            }
                            resolve(result);
                        });
                    });

                    req.on('error', (error) => {
                        lastError = error;
                        reject(new Error('Connection failed: ' + error.message));
                    });

                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Request timed out'));
                    });

                    if (options.body) {
                        req.write(options.body);
                    }
                    req.end();
                }

                makeRequest(urlObj);
            });
        } catch (error) {
            lastError = error;
            if (attempt === retryCount - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }
    throw lastError;
}

// HTML modification and URL rewriting functions
function modifyHtml(html, baseUrl) {
    const proxyScript = `
        <script>
            (function() {
                const resourceCache = new Map();
                const preloadLinks = new Set();
                let isOnline = navigator.onLine;

                window.addEventListener('online', () => isOnline = true);
                window.addEventListener('offline', () => isOnline = false);

                function prefetchResource(url) {
                    if (preloadLinks.has(url)) return;
                    const link = document.createElement('link');
                    link.rel = 'prefetch';
                    link.href = url;
                    document.head.appendChild(link);
                    preloadLinks.add(url);
                }

                async function loadUrl(url, pushState = true) {
                    try {
                        const response = await fetch('/watch', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ url: url })
                        });
                        
                        if (!response.ok) throw new Error('Failed to load page');
                        
                        const html = await response.text();
                        if (pushState) {
                            history.pushState({ url: url }, '', '/watch?url=' + encodeURIComponent(url));
                        }
                        document.open();
                        document.write(html);
                        document.close();
                    } catch (error) {
                        console.error('Navigation error:', error);
                    }
                }

                // Override fetch API
                const originalFetch = window.fetch;
                window.fetch = async (url, options = {}) => {
                    if (!isOnline) throw new Error('You are offline');
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const cacheKey = absoluteUrl + JSON.stringify(options);
                        
                        if (resourceCache.has(cacheKey)) {
                            return resourceCache.get(cacheKey).clone();
                        }

                        const response = await originalFetch('/watch?url=' + encodeURIComponent(absoluteUrl), {
                            ...options,
                            headers: {
                                ...options.headers,
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });

                        if (!response.ok) throw new Error('Resource fetch failed');
                        resourceCache.set(cacheKey, response.clone());
                        return response;
                    } catch (e) {
                        console.error('Fetch error:', e);
                        return originalFetch(url, options);
                    }
                };

                // Override XMLHttpRequest
                const XHR = XMLHttpRequest.prototype;
                const originalOpen = XHR.open;
                XHR.open = function(method, url, ...rest) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        prefetchResource('/watch?url=' + encodeURIComponent(absoluteUrl));
                        return originalOpen.call(this, method, '/watch?url=' + encodeURIComponent(absoluteUrl), ...rest);
                    } catch (e) {
                        return originalOpen.call(this, method, url, ...rest);
                    }
                };

                // Handle clicks on links
                window.addEventListener('click', function(e) {
                    const link = e.target.closest('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && !href.startsWith('javascript:') && !href.startsWith('#') && 
                            !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                            e.preventDefault();
                            const absoluteUrl = new URL(href, window.location.href).href;
                            loadUrl(absoluteUrl);
                        }
                    }
                }, true);

                // Override location methods
                const originalAssign = window.location.assign;
                window.location.assign = (url) => {
                    const absoluteUrl = new URL(url, window.location.href).href;
                    loadUrl(absoluteUrl);
                };

                const originalReplace = window.location.replace;
                window.location.replace = (url) => {
                    const absoluteUrl = new URL(url, window.location.href).href;
                    loadUrl(absoluteUrl);
                };
            })();
        </script>
    `;

    return html
        .replace(/<head>/i, `<head><base href="${baseUrl}">`)
        .replace(/<\/head>/i, `${proxyScript}</head>`)
        .replace(/(href|src|action)=["']((?!data:|javascript:|#|mailto:|tel:).+?)["']/gi, (match, attr, url) => {
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                return `${attr}="/watch?url=${encodeURIComponent(absoluteUrl)}"`;
            } catch (e) {
                return match;
            }
        })
        .replace(/url\(['"]?((?!data:).+?)['"]?\)/gi, (match, url) => {
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                return `url('/watch?url=${encodeURIComponent(absoluteUrl)}')`;
            } catch (e) {
                return match;
            }
        });
}

// Main route handlers
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Web Proxy ${VERSION}</title>
            <style>
                :root {
                    --primary-color: #2196F3;
                    --hover-color: #1976D2;
                    --background: #f5f5f5;
                    --card-background: #ffffff;
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }

                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                    line-height: 1.6;
                    background: var(--background);
                    color: #333;
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                }

                .container {
                    width: 100%;
                    max-width: 600px;
                    padding: 2rem;
                }

                .proxy-card {
                    background: var(--card-background);
                    border-radius: 10px;
                    padding: 2rem;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }

                .title {
                    text-align: center;
                    margin-bottom: 2rem;
                    color: var(--primary-color);
                }

                .proxy-form {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .input-group {
                    position: relative;
                }

                .url-input {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e0e0e0;
                    border-radius: 6px;
                    font-size: 16px;
                    transition: all 0.3s ease;
                }

                .url-input:focus {
                    border-color: var(--primary-color);
                    outline: none;
                    box-shadow: 0 0 0 3px rgba(33, 150, 243, 0.1);
                }

                .submit-btn {
                    background: var(--primary-color);
                    color: white;
                    border: none;
                    padding: 12px;
                    border-radius: 6px;
                    font-size: 16px;
                    cursor: pointer;
                    transition: background 0.3s ease;
                }

                .submit-btn:hover {
                    background: var(--hover-color);
                }

                .version {
                    position: fixed;
                    bottom: 1rem;
                    right: 1rem;
                    font-size: 0.8rem;
                    color: #666;
                }

                #loading {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(255, 255, 255, 0.9);
                    justify-content: center;
                    align-items: center;
                    z-index: 1000;
                }

                .loader {
                    width: 48px;
                    height: 48px;
                    border: 5px solid var(--primary-color);
                    border-bottom-color: transparent;
                    border-radius: 50%;
                    animation: rotation 1s linear infinite;
                }

                @keyframes rotation {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="proxy-card">
                    <h1 class="title">Web Proxy</h1>
                    <form id="proxyForm" class="proxy-form">
                        <div class="input-group">
                            <input type="url" 
                                   class="url-input" 
                                   placeholder="Enter URL (e.g., https://example.com)" 
                                   required
                                   pattern="https?://.*"
                                   title="Please enter a valid URL starting with http:// or https://">
                        </div>
                        <button type="submit" class="submit-btn">Browse</button>
                    </form>
                </div>
            </div>
            <div class="version">Version ${VERSION}</div>
            <div id="loading">
                <div class="loader"></div>
            </div>
            <script>
                document.getElementById('proxyForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const url = e.target.querySelector('input').value;
                    document.getElementById('loading').style.display = 'flex';
                    try {
                        const response = await fetch('/watch', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ url })
                        });
                        
                        if (!response.ok) throw new Error('Failed to load page');
                        
                        const html = await response.text();
                        document.open();
                        document.write(html);
                        document.close();
                    } catch (error) {
                        alert('Error loading page: ' + error.message);
                        document.getElementById('loading').style.display = 'none';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Watch route handlers
app.get('/watch', async (req, res) => {
    try {
        const targetUrl = decodeURIComponent(req.query.url);
        const response = await fetchWithRedirects(targetUrl);
        
        // Copy original headers while excluding problematic ones
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy'].includes(key.toLowerCase())) {
                res.set(key, value);
            }
        });

        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('html')) {
            const html = response.data.toString();
            const modifiedHtml = modifyHtml(html, targetUrl);
            res.send(modifiedHtml);
        } else {
            // Handle binary data (images, videos, etc.)
            res.send(response.data);
        }
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(503).json({
            error: 'Resource loading failed',
            details: error.message,
            retryable: true
        });
    }
});

app.post('/watch', async (req, res) => {
    try {
        let targetUrl = req.body.url;
        if (!targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }
        
        const response = await fetchWithRedirects(targetUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        const contentType = response.headers['content-type'] || '';
        const html = response.data.toString();
        const modifiedHtml = modifyHtml(html, targetUrl);
        
        res.send(modifiedHtml);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(503).json({
            error: 'Page loading failed',
            details: error.message,
            retryable: true
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({
        error: 'Internal server error',
        details: err.message,
        retryable: true
    });
});

// Cache maintenance
setInterval(() => {
    cache.prune();
}, 300000); // Every 5 minutes

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
});

module.exports = app;
