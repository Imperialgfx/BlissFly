const express = require('express');
const cors = require('cors');
const https = require('https');
const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = 'v1.03';

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
          body { 
            font-family: Arial, sans-serif; 
            padding: 20px;
            background: #f5f5f5;
            position: relative;
            min-height: 100vh;
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
            text-align: center;
            margin-top: 20px;
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
        <form id="proxyForm">
          <input type="text" name="url" placeholder="Enter website URL">
          <button type="submit">Browse</button>
        </form>
        <div id="loading">
          <div class="loader"></div>
          <div id="loadingText">Loading...</div>
        </div>
        <div class="version">${VERSION}</div>
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
            loading.style.display = 'block';
            
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
              document.open();
              document.write(html);
              document.close();
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

app.post('/proxy', async (req, res) => {
  try {
    const targetUrl = req.body.url.startsWith('http') ? req.body.url : 'https://' + req.body.url;
    
    const fetchData = new Promise((resolve, reject) => {
      https.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve(data);
        });
      }).on('error', (err) => {
        reject(err);
      });
    });

    const html = await fetchData;
    res.send(html);
  } catch (error) {
    res.status(500).send('Failed to load the requested page');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// v1.03
