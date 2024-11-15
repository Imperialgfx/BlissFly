const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = 'v1.05';

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <html>
      <head>
        <title>Web Viewer</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          /* Previous styles remain the same */
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
              
              const html = await response.text();
              const modifiedHtml = html.replace(/<a([^>]*)href="([^"]*)"([^>]*)>/g, (match, p1, p2, p3) => {
                const absoluteUrl = new URL(p2, url).href;
                return '<a' + p1 + 'href="/proxy?url=' + encodeURIComponent(absoluteUrl) + '"' + p3 + '>';
              });
              
              document.open();
              document.write(modifiedHtml);
              document.close();
              
              // Wait for all resources to load
              window.onload = () => {
                loading.style.display = 'none';
                clearInterval(loadingInterval);
              };
            } catch (error) {
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

app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = decodeURIComponent(req.query.url);
    const html = await fetchWithRedirects(targetUrl);
    res.send(html);
  } catch (error) {
    res.status(500).send('Failed to load the page');
  }
});

app.post('/proxy', async (req, res) => {
  try {
    const targetUrl = req.body.url.startsWith('http') ? req.body.url : 'https://' + req.body.url;
    const html = await fetchWithRedirects(targetUrl);
    res.send(html);
  } catch (error) {
    res.status(500).send('Failed to load the requested page');
  }
});

async function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    function makeRequest(currentUrl, redirectCount = 0) {
      protocol.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0'
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error('Too many redirects'));
            return;
          }
          const nextUrl = new URL(response.headers.location, currentUrl).href;
          makeRequest(nextUrl, redirectCount + 1);
        } else {
          let data = '';
          response.on('data', (chunk) => data += chunk);
          response.on('end', () => resolve(data));
        }
      }).on('error', reject);
    }

    makeRequest(url);
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// v1.05
