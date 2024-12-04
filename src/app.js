const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { BlissFlyClient } = require('./bf.handler.js');
const { BlissFlyBundle } = require('./bf.bundle.js');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve the proxy homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static routes for proxy components
app.get('/bf.handler.js', (req, res) => {
    res.sendFile(__dirname + '/bf.handler.js');
});

app.get('/bf.bundle.js', (req, res) => {
    res.sendFile(__dirname + '/bf.bundle.js');
});

app.get('/bf.client.js', (req, res) => {
    res.sendFile(__dirname + '/bf.client.js');
});

// Search endpoint
app.post('/search', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const client = new BlissFlyClient();
    const encodedUrl = client.codec.encode(url);
    res.json({ url: `/watch?url=${encodedUrl}` });
});

// Main proxy route
app.get('/watch', async (req, res) => {
    try {
        const encodedUrl = req.query.url;
        if (!encodedUrl) {
            return res.status(400).send('URL parameter required');
        }

        const client = new BlissFlyClient();
        const bundle = new BlissFlyBundle(client);
        const url = client.codec.decode(encodedUrl);
        const baseUrl = new URL(url).origin;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Origin': baseUrl,
                'Referer': baseUrl
            }
        });

        const contentType = response.headers.get('content-type') || '';

        // Handle binary files and media
        if (!contentType.includes('text') && 
            !contentType.includes('javascript') && 
            !contentType.includes('css') && 
            !contentType.includes('html') && 
            !contentType.includes('json')) {
            res.set('Content-Type', contentType);
            return response.body.pipe(res);
        }

        let content = await response.text();

        // Copy relevant headers
        const headersToCopy = ['content-type', 'cache-control', 'expires', 'vary'];
        headersToCopy.forEach(header => {
            const value = response.headers.get(header);
            if (value) res.set(header, value);
        });

        // Set security headers
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'X-Frame-Options': 'SAMEORIGIN',
            'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
            'X-Content-Type-Options': 'nosniff'
        });

        // Process content based on type
        if (contentType.includes('html')) {
            content = await bundle.rewriteHtml(content, url);
            res.set('Content-Type', 'text/html');
        } else if (contentType.includes('css')) {
            content = bundle.rewriteCss(content, url);
            res.set('Content-Type', 'text/css');
        } else if (contentType.includes('javascript')) {
            content = bundle.rewriteJs(content);
            res.set('Content-Type', 'application/javascript');
        } else if (contentType.includes('json')) {
            res.set('Content-Type', 'application/json');
        }

        res.send(content);

    } catch (error) {
        console.error('BlissFly Error:', error);
        res.status(500).send('Error loading content');
    }
});

// WebSocket upgrade handler
app.on('upgrade', (request, socket, head) => {
    const client = new BlissFlyClient();
    const url = client.codec.decode(request.url.slice(client.prefix.length));
    
    const wsClient = new WebSocket(url);
    
    wsClient.on('open', () => {
        wsClient.pipe(socket);
        socket.pipe(wsClient);
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
