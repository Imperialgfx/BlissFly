const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = 'v1.09';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
            background: white;
            z-index: 1000;
            justify-content: center;
            align-items: center;
            flex-direction: column;
          }
          .loader {
            display: inline-grid;
            width: 30px;
            aspect-ratio: 1;
            background: #574951;
            animation: 
              l12-0 4s steps(4) infinite,
              l12-1 6s linear infinite;
          }
          .loader:before,
          .loader:after {
            content: "";
            grid-area: 1/1;
            background: #83988E;
            clip-path: polygon(100% 50%,65.45% 97.55%,9.55% 79.39%,9.55% 20.61%,65.45% 2.45%);
            transform-origin: right;
            translate: -100% 50%;
            scale: 1.7;
            animation: l12-2 1s linear infinite;
          }
          .loader:after {
            clip-path: polygon(90.45% 79.39%,34.55% 97.55%,0% 50%,34.55% 2.45%,90.45% 20.61%);
            transform-origin: left;
            translate: 100% -50%;
          }
          @keyframes l12-0 {
            to{rotate: 1turn}
          }
          @keyframes l12-1 {
            to{transform: rotate(1turn)}
          }
          @keyframes l12-2 {
            0%{rotate: 36deg}
            to{rotate: -126deg}
          }
          #loadingText {
            margin-top: 10px;
            color: #574951;
          }
        </style>
      </head>
      <body>
        <div id="content">
          <form id="proxyForm">
            <input type="text" name="url" placeholder="Enter website URL">
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
            
            const loadingInterval = setInterval(updateLoadingText, 500);

            try {
              const response = await fetch('/proxy', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
              });
              
              if (!response.ok) {
                throw new Error('Network response was not ok');
              }
              
              const html = await response.text();
              document.open();
              document.write(html);
              document.close();
              
              window.addEventListener('load', function() {
                const loadingElement = document.getElementById('loading');
                if (loadingElement) {
                  loadingElement.style.display = 'none';
                }
                clearInterval(loadingInterval);
              });
            } catch (error) {
              console.error('Error:', error);
              alert('Failed to load the page. Please try again.');
              loading.style.display = 'none';
              clearInterval(loadingInterval);
            }
          });
        </script>
      </body>
    </html>
  `);
});
function modifyHtml(html, baseUrl) {
    const proxyScript = `
        <script>
            (function() {
                // Intercept fetch requests
                const originalFetch = window.fetch;
                window.fetch = async (url, options = {}) => {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        return originalFetch('/proxy?url=' + encodeURIComponent(absoluteUrl), {
                            ...options,
                            headers: {
                                ...options.headers,
                                'X-Requested-With': 'XMLHttpRequest'
                            }
                        });
                    } catch (e) {
                        return originalFetch(url, options);
                    }
                };

                // Intercept XHR requests
                const XHR = XMLHttpRequest.prototype;
                const originalOpen = XHR.open;
                XHR.open = function(method, url, ...rest) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        return originalOpen.call(this, method, '/proxy?url=' + encodeURIComponent(absoluteUrl), ...rest);
                    } catch (e) {
                        return originalOpen.call(this, method, url, ...rest);
                    }
                };

                // Override window.location methods
                const originalAssign = window.location.assign;
                window.location.assign = (url) => {
                    window.location.href = '/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href);
                };

                const originalReplace = window.location.replace;
                window.location.replace = (url) => {
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

async function fetchWithRedirects(url, maxRedirects = 5) {
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
            }
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
                        resolve({
                            data: Buffer.concat(chunks),
                            headers: response.headers,
                            statusCode: response.statusCode
                        });
                    });
                }
            });

            req.on('error', reject);
            req.end();
        }

        makeRequest(url);
    });
}

app.get('/proxy', async (req, res) => {
    try {
        const targetUrl = decodeURIComponent(req.query.url);
        const response = await fetchWithRedirects(targetUrl);
        
        Object.entries(response.headers).forEach(([key, value]) => {
            if (key !== 'content-encoding' && key !== 'content-length') {
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// v1.09
