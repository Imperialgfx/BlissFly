const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { Buffer } = require('buffer');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

// Core Configuration
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.22';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;
const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 600000;
const MAX_REDIRECTS = 5;

// Content Types and Security Headers
const PROCESSABLE_TYPES = [
    'text/html',
    'text/css',
    'application/javascript',
    'text/javascript',
    'application/json',
    'text/plain',
    'application/xml',
    'text/xml'
];

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'X-DNS-Prefetch-Control': 'on',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

// Initialize Express and Server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Enhanced Cache Implementation
class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || MAX_CACHE_SIZE;
        this.maxAge = options.maxAge || CACHE_TTL;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalRequests: 0
        };
    }

    async set(key, value, customTTL) {
        if (this.storage.size >= this.maxSize) {
            await this._evictOldest();
        }

        this.storage.set(key, {
            value,
            expires: Date.now() + (customTTL || this.maxAge)
        });
    }

    async get(key) {
        this.stats.totalRequests++;
        const item = this.storage.get(key);

        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() > item.expires) {
            this.storage.delete(key);
            this.stats.evictions++;
            return null;
        }

        this.stats.hits++;
        return item.value;
    }

    async _evictOldest() {
        const oldest = [...this.storage.entries()]
            .sort((a, b) => a[1].expires - b[1].expires)[0];
        if (oldest) {
            this.storage.delete(oldest[0]);
            this.stats.evictions++;
        }
    }
}

// Initialize Cache
const cache = new AdvancedCache();

// Content Transformer
class ContentTransformer {
    static async transform(content, type, baseUrl) {
        if (!content) return content;
        
        switch(type) {
            case 'text/html':
                return this.transformHtml(content, baseUrl);
            case 'text/css':
                return this.transformCss(content, baseUrl);
            case 'application/javascript':
            case 'text/javascript':
                return this.transformJs(content, baseUrl);
            default:
                return content;
        }
    }

    static transformHtml(html, baseUrl) {
        return html.replace(/(href|src|action)=['"]([^'"]+)['"]/g, (match, attr, url) => {
            if (url.startsWith('data:') || url.startsWith('#')) return match;
            const absoluteUrl = new URL(url, baseUrl).href;
            const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
            return `${attr}="/proxy?url=${encodedUrl}"`;
        });
    }

    static transformCss(css, baseUrl) {
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
            if (url.startsWith('data:')) return match;
            const absoluteUrl = new URL(url, baseUrl).href;
            const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
            return `url('/proxy?url=${encodedUrl}')`;
        });
    }

    static transformJs(js, baseUrl) {
        // Basic JS transformation
        return js.replace(/(['"])(https?:\/\/[^'"]+)(['"])/g, (match, q1, url, q2) => {
            const encodedUrl = Buffer.from(url).toString('base64');
            return `${q1}/proxy?url=${encodedUrl}${q2}`;
        });
    }
}

// Main route handlers
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>BlissFly 🪰</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
        <style>
            :root {
                --primary-color: #2196F3;
                --hover-color: #1976D2;
                --background: #f5f5f5;
                --card-background: #ffffff;
                --error-color: #ff4444;
                --poop-color: #8B4513;
                --poop-shadow: rgba(139, 69, 19, 0.4);
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
                overflow: hidden;
                position: relative;
            }

            .container {
                width: 100%;
                max-width: 600px;
                padding: 2rem;
                perspective: 1000px;
                position: relative;
            }

            .proxy-card {
                background: var(--card-background);
                border-radius: 10px;
                padding: 2rem;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                position: relative;
                transition: transform 0.3s ease;
                transform-style: preserve-3d;
                pointer-events: none;
            }

            .proxy-card::after {
                content: '';
                position: absolute;
                bottom: -20px;
                left: 50%;
                transform: translateX(-50%);
                width: 100%;
                height: 20px;
                border-radius: 50%;
                background: var(--poop-shadow);
                opacity: 0;
                transition: all 0.3s ease;
                filter: blur(8px);
            }

            .poop-splotch {
                position: absolute;
                background: var(--poop-color);
                border-radius: 50%;
                opacity: 0;
                transform: scale(0);
                transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                pointer-events: none;
            }

            .poop-splotch.active {
                opacity: 0.6;
                transform: scale(1);
            }

            .splotch-fly {
                position: absolute;
                font-size: 12px;
                animation: flyBuzz 2s infinite;
            }

            @keyframes flyBuzz {
                0%, 100% { transform: translate(0, 0) rotate(0deg); }
                25% { transform: translate(3px, -3px) rotate(10deg); }
                50% { transform: translate(-2px, -5px) rotate(-15deg); }
                75% { transform: translate(-4px, 2px) rotate(5deg); }
            }

            .mouse-fly {
                position: fixed;
                width: 20px;
                height: 20px;
                pointer-events: none;
                z-index: 1000;
                transition: transform 0.1s ease;
            }

            .fly-particle {
                position: fixed;
                width: 4px;
                height: 4px;
                background: rgba(0, 255, 0, 0.3);
                border-radius: 50%;
                pointer-events: none;
                animation: particleFade 1s ease-out forwards;
            }

            @keyframes particleFade {
                0% { transform: scale(1); opacity: 0.6; }
                100% { transform: scale(0); opacity: 0; }
            }

            .proxy-form {
                pointer-events: auto;
                position: relative;
                z-index: 2;
                display: flex;
                flex-direction: column;
                gap: 1rem;
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
                transition: all 0.3s ease;
            }

            .submit-btn:hover {
                background: var(--hover-color);
                transform: translateY(-2px);
            }

            .title {
                text-align: center;
                margin-bottom: 2rem;
                color: var(--primary-color);
                font-size: 2.5em;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .title-fly {
                margin-left: 10px;
                font-size: 1.2em;
                animation: flyHover 2s infinite;
            }

            @keyframes flyHover {
                0%, 100% { transform: translate(0, 0); }
                50% { transform: translate(5px, -5px); }
            }

            .info-warning {
                background: linear-gradient(135deg, #f8f9fa, #e9ecef);
                border: 1px solid #dee2e6;
                border-radius: 10px;
                padding: 15px;
                margin-top: 20px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
                transition: all 0.3s ease;
            }

            .info-content {
                background: white;
                border: 1px solid #dee2e6;
                border-top: none;
                border-radius: 0 0 10px 10px;
                padding: 15px;
                margin-top: -1px;
                transform-origin: top;
                transform: scaleY(0);
                opacity: 0;
                transition: all 0.3s ease;
            }

            .info-content.active {
                transform: scaleY(1);
                opacity: 1;
            }

            .error-popup {
                position: fixed;
                top: 20px;
                right: 20px;
                background: var(--error-color);
                color: white;
                padding: 15px 25px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(255, 68, 68, 0.2);
                transform: translateX(120%);
                animation: slideIn 0.3s forwards, slideOut 0.3s 2.7s forwards;
            }

            @keyframes slideIn {
                to { transform: translateX(0); }
            }

            @keyframes slideOut {
                to { transform: translateX(120%); }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="proxy-card">
                <h1 class="title">BlissFly<span class="title-fly">🪰</span></h1>
                <form id="proxyForm" class="proxy-form">
                    <input type="text" 
                           class="url-input" 
                           placeholder="Enter website URL" 
                           required
                           autocomplete="off"
                           spellcheck="false">
                    <button type="submit" class="submit-btn">Browse</button>
                </form>
            </div>
            <div class="info-warning">
                <div class="warning-icon">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Important Information</span>
                </div>
                <i class="fas fa-chevron-down dropdown-arrow"></i>
            </div>
            <div class="info-content">
                This proxy only searches with URLs please use a URL when searching (example.com)
            </div>
        </div>

        <script>
            document.addEventListener('DOMContentLoaded', function() {
                const form = document.getElementById('proxyForm');
                const input = form.querySelector('input');
                const proxyCard = document.querySelector('.proxy-card');
                const infoWarning = document.querySelector('.info-warning');
                const infoContent = document.querySelector('.info-content');
                const dropdownArrow = document.querySelector('.dropdown-arrow');
                const container = document.querySelector('.container');

                // Create mouse following fly
                const flyFollower = document.createElement('div');
                flyFollower.className = 'mouse-fly';
                flyFollower.innerHTML = '🪰';
                document.body.appendChild(flyFollower);

                // Splotch management
                const splotches = [];
                const maxSplotches = 5;

                function createSplotch(x, y, intensity) {
                    const splotch = document.createElement('div');
                    splotch.className = 'poop-splotch';
                    const size = 20 + (intensity * 30);
                    
                    splotch.style.width = \`\${size}px\`;
                    splotch.style.height = \`\${size}px\`;
                    splotch.style.left = \`\${x}px\`;
                    splotch.style.top = \`\${y}px\`;
                    
                    // Add flies to splotch
                    const flyCount = Math.floor(intensity * 3) + 1;
                    for(let i = 0; i < flyCount; i++) {
                        const fly = document.createElement('span');
                        fly.className = 'splotch-fly';
                        fly.innerHTML = '🪰';
                        fly.style.left = \`\${Math.random() * size}px\`;
                        fly.style.top = \`\${Math.random() * size}px\`;
                        splotch.appendChild(fly);
                    }

                    container.appendChild(splotch);
                    setTimeout(() => splotch.classList.add('active'), 10);
                    
                    splotches.push(splotch);
                    if(splotches.length > maxSplotches) {
                        const oldSplotch = splotches.shift();
                        oldSplotch.classList.remove('active');
                        setTimeout(() => oldSplotch.remove(), 300);
                    }
                }

                // Particle effect for fly
                function createParticle(x, y) {
                    const particle = document.createElement('div');
                    particle.className = 'fly-particle';
                    particle.style.left = \`\${x}px\`;
                    particle.style.top = \`\${y}px\`;
                    document.body.appendChild(particle);
                    
                    setTimeout(() => particle.remove(), 1000);
                }

                // Enhanced tilt effect with poop splotches
                document.addEventListener('mousemove', (e) => {
                    const rect = proxyCard.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    
                    const centerX = rect.width / 2;
                    const centerY = rect.height / 2;
                    
                    const tiltX = (y - centerY) / 20;
                    const tiltY = (centerX - x) / 20;
                    
                    const distance = Math.sqrt(
                        Math.pow(x - centerX, 2) + 
                        Math.pow(y - centerY, 2)
                    );
                    
                    const maxDistance = Math.sqrt(
                        Math.pow(rect.width / 2, 2) + 
                        Math.pow(rect.height / 2, 2)
                    );
                    
                    const intensity = Math.min(distance / maxDistance, 1);
                    
                    proxyCard.style.transform = \`
                        perspective(1000px) 
                        rotateX(\${tiltX}deg) 
                        rotateY(\${tiltY}deg)
                    \`;

                    // Update shadow intensity
                    proxyCard.style.setProperty('--shadow-intensity', intensity);
                    proxyCard.style.boxShadow = \`0 \${4 + (intensity * 8)}px \${6 + (intensity * 12)}px rgba(139, 69, 19, \${intensity * 0.4})\`;
                    
                    // Create splotches based on tilt intensity
                    if(intensity > 0.5 && Math.random() < 0.03) {
                        const splotchX = rect.left + (Math.random() * rect.width);
                        const splotchY = rect.bottom + (Math.random() * 50);
                        createSplotch(splotchX, splotchY, intensity);
                    }

                    // Update fly follower
                    flyFollower.style.transform = \`translate(\${e.clientX - 10}px, \${e.clientY - 10}px)\`;
                    if(Math.random() < 0.1) createParticle(e.clientX, e.clientY);
                });

                proxyCard.addEventListener('mouseleave', () => {
                    proxyCard.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
                    proxyCard.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
                    splotches.forEach(splotch => {
                        splotch.classList.remove('active');
                        setTimeout(() => splotch.remove(), 300);
                    });
                    splotches.length = 0;
                });

                // Form submission
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    let url = input.value.trim();
                    
                    url = url.replace(/^(https?:\/\/)?(www\.)?/, '');
                    
                    if (!url) {
                        showError('Please enter a URL');
                        return;
                    }

                    try {
                        const encodedUrl = btoa(encodeURIComponent('https://' + url));
                        window.location.href = '/watch?url=' + encodedUrl;
                    } catch (error) {
                        showError('Invalid URL format');
                    }
                });

                // Info warning dropdown
                infoWarning.addEventListener('click', () => {
                    infoContent.classList.toggle('active');
                    dropdownArrow.style.transform = 
                        infoContent.classList.contains('active') ? 
                        'rotate(180deg)' : 'rotate(0deg)';
                });

                function showError(message) {
                    const existingError = document.querySelector('.error-popup');
                    if (existingError) existingError.remove();

                    const errorPopup = document.createElement('div');
                    errorPopup.className = 'error-popup';
                    errorPopup.textContent = message;
                    document.body.appendChild(errorPopup);
                }

                input.focus();
            });
        </script>
    </body>
    </html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
});

// Watch route handler
app.get('/watch', async (req, res) => {
    try {
        const encodedUrl = req.query.url;
        if (!encodedUrl) {
            return res.status(400).send('URL parameter is required');
        }

        const url = decodeURIComponent(Buffer.from(encodedUrl, 'base64').toString());
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const contentType = response.headers.get('content-type') || '';
        const isProcessableType = PROCESSABLE_TYPES.some(type => contentType.includes(type));

        if (!isProcessableType) {
            response.body.pipe(res);
            return;
        }

        let content = await response.text();
        content = await ContentTransformer.transform(content, contentType.split(';')[0], url);
        
        res.send(content);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Error loading page');
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    if (DEBUG) console.log('Debug mode enabled');
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!DEBUG) process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (!DEBUG) process.exit(1);
});

// WebSocket handling
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'proxy_request':
                    const response = await handleProxyRequest(data.url);
                    ws.send(JSON.stringify({
                        type: 'proxy_response',
                        data: response
                    }));
                    break;
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                    break;
            }
        } catch (error) {
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });
});

// Additional route handlers
app.get('/proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).send('URL parameter is required');
        }

        const decodedUrl = decodeURIComponent(Buffer.from(url, 'base64').toString());
        const cachedResponse = await cache.get(decodedUrl);

        if (cachedResponse) {
            res.set('X-Cache', 'HIT');
            return res.send(cachedResponse);
        }

        const response = await fetch(decodedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const contentType = response.headers.get('content-type');
        let content = await response.buffer();

        if (contentType && contentType.includes('text')) {
            content = content.toString();
            content = await ContentTransformer.transform(content, contentType.split(';')[0], decodedUrl);
        }

        await cache.set(decodedUrl, content);
        res.set('X-Cache', 'MISS');
        res.send(content);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Error processing request');
    }
});

// API endpoints
app.get('/api/stats', (req, res) => {
    res.json({
        version: VERSION,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cache: cache.stats
    });
});

app.post('/api/clear-cache', (req, res) => {
    cache.storage.clear();
    cache.stats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        totalRequests: 0
    };
    res.json({ message: 'Cache cleared successfully' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.use((req, res) => {
    res.status(404).send('Not Found');
});

// Helper functions
async function handleProxyRequest(url) {
    try {
        const response = await fetch(url);
        const contentType = response.headers.get('content-type');
        const content = await response.text();

        return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            content: await ContentTransformer.transform(content, contentType, url)
        };
    } catch (error) {
        throw new Error(`Failed to proxy request: ${error.message}`);
    }
}

function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.href;
    } catch {
        throw new Error('Invalid URL format');
    }
}

// Security middleware
app.use((req, res, next) => {
    Object.entries(SECURITY_HEADERS).forEach(([header, value]) => {
        res.setHeader(header, value);
    });
    next();
});

// Rate limiting
const rateLimit = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
};

const limiter = new Map();

app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const windowStart = now - rateLimit.windowMs;

    if (!limiter.has(ip)) {
        limiter.set(ip, []);
    }

    const requests = limiter.get(ip);
    const recentRequests = requests.filter(time => time > windowStart);

    if (recentRequests.length >= rateLimit.max) {
        return res.status(429).send('Too many requests');
    }

    recentRequests.push(now);
    limiter.set(ip, recentRequests);
    next();
});

// Cleanup old rate limit entries
setInterval(() => {
    const now = Date.now();
    const windowStart = now - rateLimit.windowMs;
    
    for (const [ip, requests] of limiter.entries()) {
        const recentRequests = requests.filter(time => time > windowStart);
        if (recentRequests.length === 0) {
            limiter.delete(ip);
        } else {
            limiter.set(ip, recentRequests);
        }
    }
}, 60000); // Clean up every minute

// Export for testing
module.exports = {
    app,
    server,
    cache,
    ContentTransformer,
    handleProxyRequest,
    sanitizeUrl
};

// Advanced caching mechanisms and performance monitoring
const performanceMetrics = {
    requestTiming: new Map(),
    cachingEfficiency: {
        hits: 0,
        misses: 0,
        efficiency: () => {
            const total = this.hits + this.misses;
            return total ? (this.hits / total) * 100 : 0;
        }
    }
};

// Extended content transformation rules
const transformationRules = {
    javascript: {
        inlineScripts: true,
        removeComments: true,
        minify: process.env.NODE_ENV === 'production'
    },
    css: {
        inlineStyles: true,
        compressImages: true,
        optimizeSelectors: true
    },
    html: {
        removeWhitespace: true,
        optimizeImages: true,
        lazyLoading: true
    }
};

// Monitoring system
class PerformanceMonitor {
    constructor() {
        this.metrics = new Map();
        this.startTime = Date.now();
    }

    track(metric, value) {
        if (!this.metrics.has(metric)) {
            this.metrics.set(metric, []);
        }
        this.metrics.get(metric).push({
            value,
            timestamp: Date.now()
        });
    }

    getMetrics() {
        return Object.fromEntries(this.metrics);
    }

    getUptime() {
        return Date.now() - this.startTime;
    }
}

const monitor = new PerformanceMonitor();

// Enhanced security layer
const securityEnhancements = {
    rateLimit: {
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: 'Too many requests from this IP'
    },
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization']
    },
    helmet: {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'"],
            }
        }
    }
};

// Utility functions for performance optimization
const optimizationUtils = {
    compressResponse: (data, type) => {
        return new Promise((resolve) => {
            if (typeof data !== 'string') {
                resolve(data);
                return;
            }
            zlib.gzip(data, (_, result) => resolve(result));
        });
    },

    deduplicateRequests: (() => {
        const pending = new Map();
        return async (key, requestFn) => {
            if (pending.has(key)) {
                return pending.get(key);
            }
            const promise = requestFn();
            pending.set(key, promise);
            try {
                return await promise;
            } finally {
                pending.delete(key);
            }
        };
    })(),

    optimizeImages: async (buffer, options = {}) => {
        const Sharp = require('sharp');
        return Sharp(buffer)
            .resize(options.width || 800)
            .jpeg({ quality: options.quality || 80 })
            .toBuffer();
    }
};

// Apply all enhancements to the main application
app.use((req, res, next) => {
    const requestStart = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - requestStart;
        monitor.track('requestDuration', duration);
    });
    
    next();
});

// Export enhanced modules
module.exports = {
    ...module.exports,
    performanceMetrics,
    transformationRules,
    monitor,
    securityEnhancements,
    optimizationUtils
};
