const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = 'v1.08';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
              
              // Ensure loading animation stays until everything is loaded
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

function rewriteUrls(html, baseUrl) {
  return html
    .replace(/(href|src|action)="(.*?)"/g, (match, attr, url) => {
      if (url.startsWith('http') || url.startsWith('//') || url.startsWith('#')) {
        return `${attr}="/proxy?url=${encodeURIComponent(url)}"`;
      }
      const absoluteUrl = new URL(url, baseUrl).href;
      return `${attr}="/proxy?url=${encodeURIComponent(absoluteUrl)}"`;
    })
    .replace(/url\(['"]?(.*?)['"]?\)/g, (match, url) => {
      if (url.startsWith('http') || url.startsWith('//') || url.startsWith('data:')) {
        return `url(/proxy?url=${encodeURIComponent(url)})`;
      }
      const absoluteUrl = new URL(url, baseUrl).href;
      return `url(/proxy?url=${encodeURIComponent(absoluteUrl)})`;
    })
    .replace(/<head>/i, `<head><base href="${baseUrl}">`)
    .replace(/window\.location/g, 'window.proxyLocation')
    .replace(/document\.location/g, 'document.proxyLocation');
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
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
            const contentType = response.headers['content-type'] || '';
            const data = Buffer.concat(chunks);
            resolve({
              data: data,
              contentType: contentType
            });
          });
        }
      });

      req.on('error', (error) => {
        console.error('Request error:', error);
        reject(error);
      });

      req.end();
    }

    makeRequest(url);
  });
}

app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = decodeURIComponent(req.query.url);
    const response = await fetchWithRedirects(targetUrl);
    
    res.set('Content-Type', response.contentType);
    
    if (response.contentType.includes('html')) {
      const html = response.data.toString();
      const processedHtml = rewriteUrls(html, targetUrl);
      res.send(processedHtml);
    } else {
      res.send(response.data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send('Failed to load the resource');
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
    const processedHtml = rewriteUrls(html, targetUrl);
    
    res.send(processedHtml);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send(`Failed to load the page: ${error.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// v1.08
