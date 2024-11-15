const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const PORT = process.env.PORT || 10000;

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
        </style>
      </head>
      <body>
        <form id="proxyForm">
          <input type="text" name="url" placeholder="Enter website URL">
          <button type="submit">Browse</button>
        </form>
        <script>
          document.getElementById('proxyForm').addEventListener('submit', function(e) {
            e.preventDefault();
            const url = document.querySelector('input[name="url"]').value;
            fetch('/fetch', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url: url })
            })
            .then(response => response.text())
            .then(html => {
              document.open();
              document.write(html);
              document.close();
            });
          });
        </script>
      </body>
    </html>
  `);
});

app.post('/fetch', async (req, res) => {
  const targetUrl = req.body.url.startsWith('http') ? req.body.url : 'https://' + req.body.url;
  
  const proxy = createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: false,
    ws: true,
    followRedirects: true,
    proxyTimeout: 30000,
    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers['x-content-type-options'] = 'nosniff';
    }
  });

  proxy(req, res, (err) => {
    if (err) {
      res.status(500).send('Proxy Error');
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// v1
