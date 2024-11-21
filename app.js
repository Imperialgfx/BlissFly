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

// Core Configuration
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.22';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;
const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 600000;

// Initialize Express and Server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Advanced Cache Implementation
class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || MAX_CACHE_SIZE;
        this.maxAge = options.maxAge || CACHE_TTL;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }

    async set(key, value, customTTL) {
        if (this.storage.size >= this.maxSize) {
            await this._evictOldest();
        }

        this.storage.set(key, {
            value,
            timestamp: Date.now(),
            expires: Date.now() + (customTTL || this.maxAge)
        });
    }

    async get(key) {
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
        let oldest = null;
        let oldestKey = null;

        for (const [key, item] of this.storage.entries()) {
            if (!oldest || item.timestamp < oldest.timestamp) {
                oldest = item;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.storage.delete(oldestKey);
            this.stats.evictions++;
        }
    }

    getStats() {
        return {
            ...this.stats,
            size: this.storage.size,
            hitRate: (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100
        };
    }

    clear() {
        this.storage.clear();
        this.stats.evictions += this.storage.size;
        console.log('Cache cleared');
    }

}

// Initialize cache
const cache = new AdvancedCache();

// Performance Monitoring
class PerformanceMonitor {
    constructor() {
        this.metrics = new Map();
        this.startTime = Date.now();
    }

    startTimer(label) {
        this.metrics.set(label, {
            start: process.hrtime(),
            end: null
        });
    }

    endTimer(label) {
        const metric = this.metrics.get(label);
        if (metric) {
            metric.end = process.hrtime(metric.start);
            return metric.end[0] * 1e9 + metric.end[1];
        }
        return null;
    }

    getMetrics() {
        const results = {};
        for (const [label, metric] of this.metrics.entries()) {
            if (metric.end) {
                results[label] = metric.end[0] * 1e9 + metric.end[1];
            }
        }
        return results;
    }
}

const performanceMonitor = new PerformanceMonitor();

// Content Transformer
class ContentTransformer {
    static async transform(content, type, baseUrl) {
        performanceMonitor.startTimer('contentTransform');
        
        if (!content) return content;
        
        let transformed;
        switch(type) {
            case 'text/html':
                transformed = await this.transformHtml(content, baseUrl);
                break;
            case 'text/css':
                transformed = await this.transformCss(content, baseUrl);
                break;
            case 'application/javascript':
            case 'text/javascript':
                transformed = await this.transformJs(content, baseUrl);
                break;
            default:
                transformed = content;
        }
        
        performanceMonitor.endTimer('contentTransform');
        return transformed;
    }

    static async transformHtml(html, baseUrl) {
        return html.replace(/(href|src|action)=['"]([^'"]+)['"]/g, (match, attr, url) => {
            if (url.startsWith('data:') || url.startsWith('#') || url.startsWith('javascript:')) {
                return match;
            }
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                return attr + '="/proxy?url=' + encodedUrl + '"';
            } catch (e) {
                return match;
            }
        });
    }

    static async transformCss(css, baseUrl) {
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
            if (url.startsWith('data:')) return match;
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                return 'url("/proxy?url=' + encodedUrl + '")';
            } catch (e) {
                return match;
            }
        });
    }

    static async transformJs(js, baseUrl) {
        return js.replace(/(['"])(https?:\/\/[^'"]+)(['"])/g, (match, q1, url, q2) => {
            try {
                const encodedUrl = Buffer.from(url).toString('base64');
                return q1 + '/proxy?url=' + encodedUrl + q2;
            } catch (e) {
                return match;
            }
        });
    }
}

// Security Features
class SecurityManager {
    static validateUrl(url) {
        try {
            const parsedUrl = new URL(url);
            return !this.isBlockedDomain(parsedUrl.hostname);
        } catch (e) {
            return false;
        }
    }

    static isBlockedDomain(domain) {
        const blockedDomains = [
            'localhost',
            '127.0.0.1',
            '0.0.0.0',
            '[::1]'
        ];
        return blockedDomains.some(blocked => domain.includes(blocked));
    }

    static sanitizeHeaders(headers) {
        const sanitized = {};
        for (const [key, value] of Object.entries(headers)) {
            if (!key.toLowerCase().startsWith('sec-')) {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }

    static addSecurityHeaders(res) {
        const headers = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: *;",
            'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
        };
        
        Object.entries(headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
    }
}

// Middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Add security headers to all responses
app.use((req, res, next) => {
    SecurityManager.addSecurityHeaders(res);
    next();
});

// Main route handler
app.get('/', (req, res) => {
    performanceMonitor.startTimer('mainRoute');
    
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
                z-index: 1;
            }

            .proxy-card {
                background: var(--card-background);
                border-radius: 10px;
                padding: 2rem;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                position: relative;
                transition: transform 0.3s ease, box-shadow 0.3s ease;
                transform-style: preserve-3d;
                z-index: 2;
            }

            .proxy-form {
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
                position: relative;
                z-index: 2;
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

            .poop-splotch {
                position: absolute;
                background: var(--poop-color);
                border-radius: 50%;
                opacity: 0;
                transform: scale(0);
                transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                pointer-events: none;
                z-index: 1;
                filter: blur(1px);
            }

            .poop-splotch.active {
                opacity: 0.6;
                transform: scale(1);
            }

            .splotch-fly {
                position: absolute;
                font-size: 12px;
                animation: flyBuzz 2s infinite;
                z-index: 2;
                pointer-events: none;
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
                transition: all 0.1s ease;
                font-size: 20px;
                transform-origin: center;
                will-change: transform;
            }

            .fly-particle {
                position: fixed;
                width: 4px;
                height: 4px;
                background: rgba(0, 255, 0, 0.3);
                border-radius: 50%;
                pointer-events: none;
                animation: particleFade 1s ease-out forwards;
                z-index: 999;
            }

            @keyframes particleFade {
                0% { 
                    transform: scale(1) translate(0, 0); 
                    opacity: 0.6; 
                }
                100% { 
                    transform: scale(0) translate(var(--moveX, 10px), var(--moveY, -10px)); 
                    opacity: 0; 
                }
            }

            .info-warning {
                background: linear-gradient(135deg, #f8f9fa, #e9ecef);
                border: 1px solid #dee2e6;
                border-radius: 10px 10px 0 0;
                padding: 15px;
                margin-top: 20px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
                transition: all 0.3s ease;
                user-select: none;
                position: relative;
                z-index: 2;
            }

            .info-warning:hover {
                background: linear-gradient(135deg, #e9ecef, #dee2e6);
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
                position: relative;
                z-index: 1;
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
                z-index: 1000;
            }

            @keyframes slideIn {
                to { transform: translateX(0); }
            }

            @keyframes slideOut {
                to { transform: translateX(120%); }
            }

            .dropdown-arrow {
                transition: transform 0.3s ease;
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
                console.log('Initializing BlissFly interface...');
                
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

                // Initialize tracking variables
                let lastMouseX = 0;
                let lastMouseY = 0;
                let flyRotation = 0;

                // Splotch management
                const splotches = [];
                const maxSplotches = 5;
                let lastSplotchTime = 0;
                const splotchCooldown = 100; // Milliseconds between splotches

                function createSplotch(x, y, intensity) {
                    const now = Date.now();
                    if (now - lastSplotchTime < splotchCooldown) return;
                    lastSplotchTime = now;

                    const splotch = document.createElement('div');
                    splotch.className = 'poop-splotch';
                    const size = 20 + (intensity * 30);
                    
                    splotch.style.width = size + 'px';
                    splotch.style.height = size + 'px';
                    splotch.style.left = x + 'px';
                    splotch.style.top = y + 'px';
                    
                    // Add flies to splotch
                    const flyCount = Math.floor(intensity * 3) + 1;
                    for(let i = 0; i < flyCount; i++) {
                        const fly = document.createElement('span');
                        fly.className = 'splotch-fly';
                        fly.innerHTML = '🪰';
                        fly.style.left = (Math.random() * size) + 'px';
                        fly.style.top = (Math.random() * size) + 'px';
                        splotch.appendChild(fly);
                    }

                    container.appendChild(splotch);
                    requestAnimationFrame(() => splotch.classList.add('active'));
                    
                    splotches.push(splotch);
                    if(splotches.length > maxSplotches) {
                        const oldSplotch = splotches.shift();
                        oldSplotch.classList.remove('active');
                        setTimeout(() => oldSplotch.remove(), 300);
                    }
                }

                // particle effect for fly
                function createParticle(x, y, mouseSpeed) {
                    const particle = document.createElement('div');
                    particle.className = 'fly-particle';
                    
                    // Calculate random movement
                    const moveX = (Math.random() - 0.5) * 20 * mouseSpeed;
                    const moveY = (Math.random() - 0.5) * 20 * mouseSpeed;
                    
                    particle.style.left = x + 'px';
                    particle.style.top = y + 'px';
                    particle.style.setProperty('--moveX', moveX + 'px');
                    particle.style.setProperty('--moveY', moveY + 'px');
                    
                    document.body.appendChild(particle);
                    setTimeout(() => particle.remove(), 1000);
                }

                // Enhanced tilt effect with poop splotches
                document.addEventListener('mousemove', (e) => {
                    // Calculate mouse speed
                    const mouseSpeed = Math.sqrt(
                        Math.pow(e.clientX - lastMouseX, 2) + 
                        Math.pow(e.clientY - lastMouseY, 2)
                    ) / 10;
                    
                    lastMouseX = e.clientX;
                    lastMouseY = e.clientY;

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
                    
                    // Apply 3D transform
                    proxyCard.style.transform = 'perspective(1000px) rotateX(' + tiltX + 'deg) rotateY(' + tiltY + 'deg)';
                    proxyCard.style.boxShadow = '0 ' + (4 + (intensity * 8)) + 'px ' + (6 + (intensity * 12)) + 'px rgba(139, 69, 19, ' + (intensity * 0.4) + ')';
                    
                    // Create splotches based on intensity and mouse speed
                    if(intensity > 0.5 && mouseSpeed > 0.5) {
                        const splotchX = rect.left + (Math.random() * rect.width);
                        const splotchY = rect.bottom + (Math.random() * 50);
                        createSplotch(splotchX, splotchY, intensity);
                    }

                    // Update fly follower with rotation based on movement
                    flyRotation += (mouseSpeed * (Math.random() > 0.5 ? 1 : -1));
                    flyFollower.style.transform = 'translate(' + (e.clientX - 10) + 'px, ' + (e.clientY - 10) + 'px) rotate(' + flyRotation + 'deg)';
                    
                    // Create particles based on mouse speed
                    if(mouseSpeed > 0.5 && Math.random() < 0.2) {
                        createParticle(e.clientX, e.clientY, mouseSpeed);
                    }
                });

                // Reset transform on mouse leave
                proxyCard.addEventListener('mouseleave', () => {
                    proxyCard.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
                    proxyCard.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
                });

                // Info dropdown
                infoWarning.addEventListener('click', () => {
                    infoContent.classList.toggle('active');
                    dropdownArrow.style.transform = infoContent.classList.contains('active') 
                        ? 'rotate(180deg)' 
                        : 'rotate(0deg)';
                });

                // fixed form submission with URL validation and processing
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    let url = input.value.trim();
                    
                    // Remove any protocol prefix if present
                    url = url.replace(/^(https?:\/\/)?(www\.)?/, '');
                    
                    if (!url) {
                        showError('Please enter a URL');
                        return;
                    }

                    try {
                        // Create loading animation
                        const submitBtn = form.querySelector('.submit-btn');
                        const originalText = submitBtn.textContent;
                        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                        submitBtn.disabled = true;

                        const encodedUrl = Buffer.from('https://' + url).toString('base64');
                        
                        // Add transition effect before navigation
                        document.body.style.opacity = '0';
                        document.body.style.transition = 'opacity 0.3s ease';
                        
                        setTimeout(() => {
                            window.location.href = '/proxy?url=' + encodedUrl;
                        }, 300);

                    } catch (error) {
                        console.error('URL processing error:', error);
                        showError('Invalid URL format');
                        submitBtn.textContent = originalText;
                        submitBtn.disabled = false;
                    }
                });

                function showError(message) {
                    const existingError = document.querySelector('.error-popup');
                    if (existingError) existingError.remove();

                    const errorPopup = document.createElement('div');
                    errorPopup.className = 'error-popup';
                    errorPopup.textContent = message;
                    
                    // Add shake animation
                    errorPopup.style.animation = 'slideIn 0.3s forwards, shake 0.5s ease-in-out, slideOut 0.3s 2.7s forwards';
                    
                    document.body.appendChild(errorPopup);
                }

                // Add shake animation keyframes
                const style = document.createElement('style');
                style.textContent = 
                    '0%, 100% { transform: translateX(0); }' +
                    '10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }' +
                    '20%, 40%, 60%, 80% { transform: translateX(5px); }';
                document.head.appendChild(style);
                    }
                `;

                // focus input on page load with smooth transition
                setTimeout(() => {
                    input.focus();
                    input.style.transition = 'all 0.3s ease';
                }, 100);

                // Initialize performance monitoring
                console.log('BlissFly interface initialized successfully');
            });
        </script>
    </body>
    </html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
});

// Proxy route handler
app.get('/proxy', async (req, res) => {
    performanceMonitor.startTimer('proxyRequest');
    try {
        const { url } = req.query;
        if (!url) {
            return res.redirect('/?error=missing_url');
        }

        const decodedUrl = decodeURIComponent(Buffer.from(url, 'base64').toString());
        
        if (!SecurityManager.validateUrl(decodedUrl)) {
            return res.redirect('/?error=invalid_url');
        }

        // Check cache first
        const cachedResponse = await cache.get(decodedUrl);
        if (cachedResponse) {
            performanceMonitor.endTimer('proxyRequest');
            res.setHeader('X-Cache', 'HIT');
            return res.send(cachedResponse);
        }

        const response = await fetch(decodedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: TIMEOUT
        });

        const contentType = response.headers.get('content-type');
        let content = await response.buffer();

        // Transform content if needed
        if (contentType && contentType.includes('text')) {
            content = content.toString();
            content = await ContentTransformer.transform(content, contentType.split(';')[0], decodedUrl);
        }

        // Cache the transformed content
        await cache.set(decodedUrl, content);
        
        // Set appropriate headers
        res.setHeader('Content-Type', contentType || 'text/plain');
        res.setHeader('X-Cache', 'MISS');
        
        performanceMonitor.endTimer('proxyRequest');
        res.send(content);

    } catch (error) {
        console.error('Proxy error:', error);
        res.redirect('/?error=fetch_failed');
    }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    
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

async function handleProxyRequest(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: TIMEOUT
        });
        
        const contentType = response.headers.get('content-type');
        const content = await response.buffer();
        
        return {
            success: true,
            contentType,
            content: content.toString('base64')
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// Enhanced Error Handling and Cleanup
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    performanceMonitor.logError('uncaughtException', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    performanceMonitor.logError('unhandledRejection', reason);
});

// Advanced Performance Monitoring
performanceMonitor.extend({
    logError: function(type, error) {
        this.errors = this.errors || [];
        this.errors.push({
            type,
            message: error.message,
            timestamp: Date.now(),
            stack: error.stack
        });
    },
    
    getErrorStats: function() {
        return {
            total: this.errors?.length || 0,
            types: this.errors?.reduce((acc, err) => {
                acc[err.type] = (acc[err.type] || 0) + 1;
                return acc;
            }, {})
        };
    }
});

// Cleanup Functions
const cleanup = {
    interval: null,
    
    start: function() {
        this.interval = setInterval(() => {
            this.cleanupCache();
            this.cleanupSockets();
            this.cleanupMetrics();
        }, 300000); // Run every 5 minutes
    },
    
    cleanupCache: function() {
        const stats = cache.getStats();
        console.log('Cache cleanup - Current size:', stats.size);
        if (stats.size > MAX_CACHE_SIZE * 0.9) {
            cache.clear();
        }
    },
    
    cleanupSockets: function() {
        wss.clients.forEach(client => {
            if (!client.isAlive) {
                return client.terminate();
            }
            client.isAlive = false;
            client.ping();
        });
    },
    
    cleanupMetrics: function() {
        const metrics = performanceMonitor.getMetrics();
        const oldMetrics = Object.keys(metrics).filter(key => 
            Date.now() - metrics[key].timestamp > 86400000 // Older than 24 hours
        );
        oldMetrics.forEach(key => delete metrics[key]);
    },
    
    stop: function() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
};

// Start cleanup process
cleanup.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Starting graceful shutdown...');
    cleanup.stop();
    
    // Close all WebSocket connections
    wss.clients.forEach(client => {
        client.terminate();
    });
    
    // Close server
    server.close(() => {
        console.log('Server closed. Process terminating...');
        process.exit(0);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`BlissFly ${VERSION} running on port ${PORT}`);
    if (DEBUG) {
        console.log('Debug mode enabled');
        console.log('Cache size:', MAX_CACHE_SIZE);
        console.log('Cache TTL:', CACHE_TTL);
    }
});

// Export for testing
module.exports = {
    app,
    cache,
    ContentTransformer,
    SecurityManager,
    performanceMonitor
};
