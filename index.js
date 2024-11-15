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
        <script>
          function navigate(event) {
            event.preventDefault();
            const url = document.querySelector('input[name="url"]').value;
            const encodedUrl = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
            window.location.href = '/proxy/' + encodedUrl;
          }
        </script>
      </head>
      <body>
        <form onsubmit="navigate(event)">
          <input type="text" name="url" placeholder="Enter website URL">
          <button type="submit">Browse</button>
        </form>
      </body>
    </html>
  `);
});

function decodeURL(encoded) {
  encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (encoded.length % 4) encoded += '=';
  return Buffer.from(encoded, 'base64').toString('ascii');
}

app.use('/proxy/:url', (req, res, next) => {
  const targetUrl = decodeURL(req.params.url);
  const finalUrl = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;

  const proxyConfig = {
    target: finalUrl,
    changeOrigin: true,
    secure: false,
    ws: true,
    followRedirects: true,
    proxyTimeout: 30000,
    pathRewrite: {
      [`^/proxy/${req.params.url}`]: '',
    },
    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers['x-content-type-options'] = 'nosniff';
      Object.keys(proxyRes.headers).forEach(key => {
        if (key === 'location') {
          const location = proxyRes.headers[key];
          const encodedLocation = Buffer.from(location).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          proxyRes.headers[key] = `/proxy/${encodedLocation}`;
        }
      });
    }
  };

  createProxyMiddleware(proxyConfig)(req, res, next);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
