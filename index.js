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
const VERSION = 'v1.11';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Add performance headers
app.use((req, res, next) => {
    res.set({
        'X-DNS-Prefetch-Control': 'on',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=300'
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
            border: 3px solid #f3f3f3;
            border-radius: 50%;
            border-top: 3px solid #007bff;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          #loadingText {
            margin-top: 10px;
            color: #333;
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
        <script>
          let dots = 0;
          let loadingInterval;

          function updateLoadingText() {
            const text = 'Loading' + '.'.repeat(dots + 1);
            document.getElementById('loadingText').textContent = text;
            dots = (dots + 1) % 3;
          }

          document.getElementById('proxyForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const url = document.querySelector('input[name="url"]').value;
            const loading = document.getElementById('loading');
            loading.style.display = 'flex';
            
            loadingInterval = setInterval(updateLoadingText, 500);

            try {
              const response = await fetch('/proxy', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
              });
              
              if (!response.ok) throw new Error('Network response was not ok');
              
              const html = await response.text();
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
              alert('Failed to load the page. Please try again.');
              loading.style.display = 'none';
              if (loadingInterval) clearInterval(loadingInterval);
            }
          });
        </script>
      </body>
    </html>
  `);
});
async function fetchWithRedirects(url, maxRedirects = 5) {
    const cachedResponse = cache.get(url);
    if (cachedResponse) return cachedResponse;

    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const options = new URL(url);
        
        const requestOptions = {
            hostname: options.hostname,
            path: options.pathname + options.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Host': options.hostname
            },
            timeout: 5000
        };

        function makeRequest(currentUrl, redirectCount = 0) {
            const req = protocol.request(currentUrl, requestOptions, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    if (redirectCount >= maxRedirects) {
                        reject(new Error('Too many redirects'));
                        return;
                    }
                    const nextUrl = new URL(response.headers.location, currentUrl);
                    makeRequest(nextUrl, redirectCount + 1);
                } else {
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
                }
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        }

        makeRequest(url);
    });
}

function modifyHtml(html, baseUrl) {
    const proxyScript = `
        <script>
            (function() {
                const resourceCache = new Map();
                const preloadLinks = new Set();

                function prefetchResource(url) {
                    if (preloadLinks.has(url)) return;
                    const link = document.createElement('link');
                    link.rel = 'prefetch';
                    link.href = url;
                    document.head.appendChild(link);
                    preloadLinks.add(url);
                }
                const originalFetch = window.fetch;
                window.fetch = async (url, options = {}) => {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const cacheKey = absoluteUrl + JSON.stringify(options);
                        
                        if (resourceCache.has(cacheKey)) {
                            return resourceCache.get(cacheKey).clone();
                        }

                        const response = await originalFetch('/proxy?url=' + encodeURIComponent(absoluteUrl), {
                            ...options,
                            headers: {
                                ...options.headers,
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });

                        resourceCache.set(cacheKey, response.clone());
                        return response;
                    } catch (e) {
                        return originalFetch(url, options);
                    }
                };

                const XHR = XMLHttpRequest.prototype;
                const originalOpen = XHR.open;
                XHR.open = function(method, url, ...rest) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        prefetchResource('/proxy?url=' + encodeURIComponent(absoluteUrl));
                        return originalOpen.call(this, method, '/proxy?url=' + encodeURIComponent(absoluteUrl), ...rest);
                    } catch (e) {
                        return originalOpen.call(this, method, url, ...rest);
                    }
                };

                window.location.assign = (url) => {
                    prefetchResource('/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href));
                    window.location.href = '/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href);
                };

                window.location.replace = (url) => {
                    prefetchResource('/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href));
                    window.location.href = '/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href);
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
                return `${attr}="/proxy?url=${encodeURIComponent(absoluteUrl)}"`;
            } catch (e) {
                return match;
            }
        })
        .replace(/url\(['"]?((?!data:).+?)['"]?\)/gi, (match, url) => {
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                return `url('/proxy?url=${encodeURIComponent(absoluteUrl)}')`;
            } catch (e) {
                return match;
            }
        });
}

app.get('/proxy', async (req, res) => {
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
        res.status(500).send('Resource loading failed');
    }
});

app.post('/proxy', async (req, res) => {
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
        res.status(500).send('Page loading failed');
    }
});

setInterval(() => {
    cache.prune();
}, 300000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// v1.11
