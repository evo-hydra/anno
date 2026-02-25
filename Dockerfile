# Stage 1: Dependencies
FROM node:18-alpine AS deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install --frozen-lockfile

# Stage 2: Builder
FROM node:18-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Stage 3: Production Dependencies
FROM node:18-alpine AS prod-deps

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --production --frozen-lockfile

# Stage 4: Runner (Production)
FROM node:18-alpine AS runner

# Install Playwright dependencies for Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    xvfb

# Tell Playwright to use the system chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy production dependencies
COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Copy necessary runtime files
COPY --chown=nodejs:nodejs .env.example ./.env.example
COPY --chown=nodejs:nodejs policies ./policies
COPY --chown=nodejs:nodejs config ./config

# Create cache directory with proper permissions
RUN mkdir -p /app/.cache && chown -R nodejs:nodejs /app/.cache

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 5213

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5213/health', (r) => { \
    let data = ''; \
    r.on('data', chunk => data += chunk); \
    r.on('end', () => { \
      try { \
        const health = JSON.parse(data); \
        process.exit(health.status === 'healthy' ? 0 : 1); \
      } catch { process.exit(1); } \
    }); \
  }).on('error', () => process.exit(1));"

# Start application
CMD ["node", "dist/server.js"]

# Stage 5: Development
FROM node:18-alpine AS development

# Install Playwright dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    udev \
    xvfb

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy package files
COPY --chown=nodejs:nodejs package*.json ./

# Install all dependencies
RUN npm install

# Copy source
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

EXPOSE 5213

CMD ["npm", "run", "dev"]
