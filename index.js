const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

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
const VERSION = 'v1.14';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    res.set({
        'X-DNS-Prefetch-Control': 'on',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    next();
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <html>
      <head>
        <title>Web Viewer</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: Arial, sans-serif; 
            margin: 0;
            padding: 0;
            background: #f5f5f5;
          }
          #content {
            padding: 20px;
          }
          form { 
            margin: 20px auto;
            max-width: 500px;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          input { 
            padding: 10px;
            width: 100%;
            margin-bottom: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
          }
          button { 
            padding: 10px 20px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.2s;
          }
          button:hover {
            background: #0056b3;
          }
          .version {
            position: fixed;
            bottom: 10px;
            right: 10px;
            font-size: 12px;
            color: #666;
          }
          #loading {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.95);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            flex-direction: column;
          }
          .loader {
            width: 64px;
            height: 64px;
            position: relative;
            background: transparent;
            border-radius: 50%;
            transform: rotate(45deg);
          }
          .loader::before {
            content: '🪰';
            position: absolute;
            font-size: 32px;
            animation: fly 2s linear infinite;
          }
          .loader::after {
            content: '💩';
            position: absolute;
            font-size: 24px;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
          }
          @keyframes fly {
            0% { transform: rotate(0deg) translateX(30px) rotate(0deg); }
            100% { transform: rotate(360deg) translateX(30px) rotate(-360deg); }
          }
          #loadingText {
            margin-top: 10px;
            color: #333;
          }
          #error {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            z-index: 1001;
            text-align: center;
          }
          #error button {
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
        <div id="content">
          <form id="proxyForm">
            <input type="text" name="url" placeholder="Enter website URL" autocomplete="off">
            <button type="submit">Browse</button>
          </form>
          <div class="version">${VERSION}</div>
        </div>
        <div id="loading">
          <div class="loader"></div>
          <div id="loadingText">Loading...</div>
        </div>
        <div id="error">
          <h3>Failed to load the page</h3>
          <p id="errorDetails"></p>
          <button onclick="retryLastRequest()">Try Again</button>
          <button onclick="hideError()">Close</button>
        </div>
        <script>
          let dots = 0;
          let loadingInterval;
          let lastRequestUrl = '';

          function updateLoadingText() {
            const text = 'Loading' + '.'.repeat(dots + 1);
            document.getElementById('loadingText').textContent = text;
            dots = (dots + 1) % 3;
          }

          function showError(message) {
            const error = document.getElementById('error');
            const errorDetails = document.getElementById('errorDetails');
            errorDetails.textContent = message;
            error.style.display = 'block';
            document.getElementById('loading').style.display = 'none';
          }

          function hideError() {
            document.getElementById('error').style.display = 'none';
          }

          function retryLastRequest() {
            hideError();
            if (lastRequestUrl) {
              loadUrl(lastRequestUrl);
            }
          }

          async function loadUrl(url, pushState = true) {
            const loading = document.getElementById('loading');
            loading.style.display = 'flex';
            lastRequestUrl = url;
            
            loadingInterval = setInterval(updateLoadingText, 500);

            try {
              const response = await fetch('/watch', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
              });
              
              if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.details || 'Failed to load the page');
              }
              
              const html = await response.text();
              if (pushState) {
                history.pushState({ url: url }, '', '/watch?url=' + encodeURIComponent(url));
              }
              document.open();
              document.write(html);
              document.close();
              
              window.addEventListener('load', function() {
                if (loadingInterval) clearInterval(loadingInterval);
                const loadingElement = document.getElementById('loading');
                if (loadingElement) loadingElement.style.display = 'none';
              });
            } catch (error) {
              console.error('Error:', error);
              showError(error.message);
              if (loadingInterval) clearInterval(loadingInterval);
            }
          }

          document.getElementById('proxyForm').addEventListener('submit', function(e) {
            e.preventDefault();
            const url = document.querySelector('input[name="url"]').value;
            loadUrl(url);
          });

          window.addEventListener('popstate', function(e) {
            if (e.state && e.state.url) {
              loadUrl(e.state.url, false);
            }
          });
        </script>
      </body>
    </html>
  `);
});

async function fetchWithRedirects(url, maxRedirects = 10, retryCount = 3) {
    const cachedResponse = cache.get(url);
    if (cachedResponse) return cachedResponse;

    const visitedUrls = new Set();

    for (let attempt = 0; attempt < retryCount; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const protocol = url.startsWith('https') ? https : http;
                const options = new URL(url);

                function makeRequest(currentUrl, redirectCount = 0) {
                    if (visitedUrls.has(currentUrl.href)) {
                        reject(new Error('Circular redirect detected'));
                        return;
                    }
                    visitedUrls.add(currentUrl.href);

                    const requestOptions = {
                        hostname: currentUrl.hostname,
                        path: currentUrl.pathname + currentUrl.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124',
                            'Accept': 'image/*, text/*, application/*, */*',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'Host': currentUrl.hostname,
                            'Sec-Fetch-Mode': 'cors',
                            'Sec-Fetch-Site': 'cross-site',
                            'Referer': currentUrl.origin
                        },
                        timeout: 15000
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

                        const encoding = response.headers['content-encoding'];
                        let output;

                        switch (encoding) {
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
                            
                            cache.set(url, result);
                            resolve(result);
                        });
                    });

                    req.on('error', (error) => {
                        console.error(`Attempt ${attempt + 1} failed:`, error);
                        reject(new Error('Connection failed: The server is not responding'));
                    });

                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Request timed out: The server took too long to respond'));
                    });

                    req.end();
                }

                makeRequest(new URL(url));
            });
        } catch (error) {
            if (attempt === retryCount - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
}

function modifyHtml(html, baseUrl) {
    const proxyScript = `
        <script>
            (function() {
                const resourceCache = new Map();
                const preloadLinks = new Set();
                let isOnline = true;

                window.addEventListener('online', function() {
                    isOnline = true;
                });
                window.addEventListener('offline', function() {
                    isOnline = false;
                });

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

                const originalFetch = window.fetch;
                window.fetch = async (url, options = {}) => {
                    if (!isOnline) {
                        throw new Error('You are offline');
                    }
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

                window.addEventListener('click', function(e) {
                    const link = e.target.closest('a');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                            e.preventDefault();
                            const absoluteUrl = new URL(href, window.location.href).href;
                            loadUrl(absoluteUrl);
                        }
                    }
                }, true);

                window.location.assign = (url) => {
                    const absoluteUrl = new URL(url, window.location.href).href;
                    loadUrl(absoluteUrl);
                };

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

app.get('/watch', async (req, res) => {
    try {
        const targetUrl = decodeURIComponent(req.query.url);
        const response = await fetchWithRedirects(targetUrl);
        
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key)) {
                res.set(key, value);
            }
        });

        const contentType = response.headers['content-type'] || '';
        
        if (contentType.includes('html')) {
            const html = response.data.toString();
            const modifiedHtml = modifyHtml(html, targetUrl);
            res.send(modifiedHtml);
        } else {
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
        
        const response = await fetchWithRedirects(targetUrl);
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

setInterval(() => {
    cache.prune();
}, 300000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// v1.14
