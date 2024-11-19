const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');
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
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const cache = new CacheManager(100);
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.16';

// WebSocket handling
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'proxy') {
                const response = await fetchWithRedirects(data.url, {
                    headers: {
                        'Upgrade': 'websocket',
                        'Connection': 'Upgrade',
                        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
                        'Sec-WebSocket-Version': '13'
                    }
                });
                ws.send(JSON.stringify({
                    type: 'response',
                    data: response.data.toString('base64'),
                    headers: response.headers
                }));
            }
        } catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });
});

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

// Enhanced URL handling functions
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
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                            'Sec-Fetch-Site': 'none',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-User': '?1',
                            'Sec-Fetch-Dest': 'document',
                            'Sec-WebSocket-Protocol': 'binary',
                            'Sec-WebSocket-Version': '13',
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

// Enhanced HTML modification function
function modifyHtml(html, baseUrl) {
    const proxyScript = `
        <script>
            (function() {
                const resourceCache = new Map();
                const preloadLinks = new Set();
                let isOnline = navigator.onLine;
                let ws = new WebSocket('ws://' + window.location.host);

                ws.onmessage = function(event) {
                    try {
                        const response = JSON.parse(event.data);
                        if (response.type === 'response') {
                            const data = atob(response.data);
                            // Handle WebSocket responses
                            if (window.gameProxy) {
                                window.gameProxy.handleMessage(data);
                            }
                        }
                    } catch (e) {
                        console.error('WebSocket message error:', e);
                    }
                };

                window.addEventListener('online', () => isOnline = true);
                window.addEventListener('offline', () => isOnline = false);

                // Enhanced link click handler
                window.addEventListener('click', function(e) {
                    const link = e.target.closest('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && !href.startsWith('javascript:') && !href.startsWith('#') && 
                            !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                            e.preventDefault();
                            e.stopPropagation();
                            
                            try {
                                const absoluteUrl = new URL(href, window.location.href).href;
                                window.location.href = '/watch?url=' + encodeURIComponent(absoluteUrl);
                            } catch (error) {
                                console.error('URL processing error:', error);
                            }
                        }
                    }
                }, true);

                // Override fetch API
                const originalFetch = window.fetch;
                window.fetch = async (url, options = {}) => {
                    if (!isOnline) throw new Error('You are offline');
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const proxyUrl = '/watch?url=' + encodeURIComponent(absoluteUrl);
                        
                        const response = await originalFetch(proxyUrl, {
                            ...options,
                            headers: {
                                ...options.headers,
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });

                        if (!response.ok) throw new Error('Resource fetch failed');
                        return response;
                    } catch (e) {
                        console.error('Fetch error:', e);
                        throw e;
                    }
                };

                // Override XMLHttpRequest
                const XHR = XMLHttpRequest.prototype;
                const originalOpen = XHR.open;
                XHR.open = function(method, url, ...rest) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const proxyUrl = '/watch?url=' + encodeURIComponent(absoluteUrl);
                        return originalOpen.call(this, method, proxyUrl, ...rest);
                    } catch (e) {
                        return originalOpen.call(this, method, url, ...rest);
                    }
                };

                // Game support
                window.gameProxy = {
                    ws: ws,
                    sendMessage: function(data) {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'proxy',
                                data: data
                            }));
                        }
                    },
                    handleMessage: function(data) {
                        // Handle game-specific messages
                        if (window.gameInstance) {
                            window.gameInstance.SendMessage('GameManager', 'ReceiveData', data);
                        }
                    }
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

                .help-text {
                    margin-top: 20px;
                    padding: 15px;
                    background: #fff;
                    border-radius: 6px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                }

                .help-text h3 {
                    color: var(--primary-color);
                    margin-bottom: 10px;
                }

                .help-text ol {
                    padding-left: 20px;
                }

                .help-text li {
                    margin: 5px 0;
                    color: #666;
                }

                .version {
                    position: fixed;
                    bottom: 1rem;
                    right: 1rem;
                    font-size: 0.8rem;
                    color: #666;
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
                    <div class="help-text">
                        <h3>How to Find a Website URL:</h3>
                        <ol>
                            <li>Go to Google and search for the website you want to visit</li>
                            <li>Right-click on the search result link</li>
                            <li>Select "Copy link address" from the menu</li>
                            <li>Paste the copied URL into the box above</li>
                        </ol>
                        <p style="margin-top: 10px; color: #666;">
                            Note: URLs must start with "http://" or "https://"
                        </p>
                    </div>
                </div>
            </div>
            <div class="version">Version ${VERSION}</div>
            <script>
                document.getElementById('proxyForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const url = e.target.querySelector('input').value;
                    window.location.href = '/watch?url=' + encodeURIComponent(url);
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
        
        // Set headers while excluding problematic ones
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
        } else if (contentType.includes('javascript')) {
            // Handle JavaScript files
            let jsContent = response.data.toString();
            jsContent = jsContent.replace(/XMLHttpRequest/g, 'ProxiedXMLHttpRequest');
            jsContent = jsContent.replace(/WebSocket/g, 'ProxiedWebSocket');
            res.set('Content-Type', 'application/javascript');
            res.send(jsContent);
        } else {
            // Handle other content types (images, videos, etc.)
            res.send(response.data);
        }
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(503).send(`
            <html>
                <body>
                    <h2>Resource Loading Error</h2>
                    <p>Failed to load: ${req.query.url}</p>
                    <p>Error: ${error.message}</p>
                    <button onclick="window.location.reload()">Retry</button>
                    <button onclick="window.location.href='/'">Return Home</button>
                </body>
            </html>
        `);
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
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    console.log(`WebSocket server active`);
});

module.exports = app;
