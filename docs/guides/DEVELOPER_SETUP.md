# Anno Developer Setup Guide

This guide helps you set up a complete Anno development environment and understand the testing framework.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Development Workflow](#development-workflow)
4. [Testing Framework](#testing-framework)
5. [Debugging Guide](#debugging-guide)
6. [Code Quality Tools](#code-quality-tools)
7. [Local Services](#local-services)
8. [IDE Configuration](#ide-configuration)

---

## Prerequisites

### Required Software

```bash
# Node.js and npm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Python 3.9+
sudo apt-get install python3.9 python3.9-dev python3.9-venv python3-pip

# Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo curl -L "https://github.com/docker/compose/releases/download/v2.12.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Git
sudo apt-get install git

# Chrome/Chromium (for browser automation)
sudo apt-get install chromium-browser

# Redis CLI (for debugging)
sudo apt-get install redis-tools

# Additional tools
sudo apt-get install curl wget jq htop tree
```

### System Requirements

```yaml
Minimum Development Setup:
  - RAM: 16GB (32GB recommended)
  - Storage: 50GB free space
  - CPU: 4 cores (8+ recommended)
  - OS: Linux (Ubuntu 20.04+), macOS 11+, Windows 10+ with WSL2

Network Requirements:
  - Internet connection for external APIs
  - Ports 5213, 8081, 6379, 7474, 7687, 5432 available
```

---

## Environment Setup

### 1. Clone Repository

```bash
git clone https://github.com/your-org/anno.git
cd anno

# Set up git hooks
git config core.hooksPath .githooks
chmod +x .githooks/*
```

### 2. Node.js Environment

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env.local

# Build TypeScript
npm run build

# Verify setup
npm run test:unit
```

### 3. Python Environment

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt
pip install -r requirements-dev.txt

# Install pre-commit hooks
pre-commit install

# Verify setup
python -m pytest tests/ -v
```

### 4. Environment Variables

Create `.env.local` with development settings:

```bash
# Core Configuration
NODE_ENV=development
LOG_LEVEL=debug
PORT=5213

# Database URLs (local Docker services)
REDIS_URL=redis://localhost:6379
NEO4J_URL=bolt://neo4j:password@localhost:7687
POSTGRES_URL=postgresql://anno:password@localhost:5432/anno_dev

# External Services (development keys)
OPENAI_API_KEY=sk-your-dev-key
WIKIDATA_ENDPOINT=https://query.wikidata.org/sparql

# Chrome Configuration
CHROME_EXECUTABLE_PATH=/usr/bin/chromium-browser
CHROME_HEADLESS=true

# Development Features
HOT_RELOAD=true
DEBUG_AGENTS=true
MOCK_EXTERNAL_APIS=true
ENABLE_CORS=true
```

### 5. Start Local Services

```bash
# Start all services with Docker Compose
docker-compose -f docker-compose.dev.yml up -d

# Or start services individually:
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password neo4j:5
docker run -d --name postgres -p 5432:5432 \
  -e POSTGRES_DB=anno_dev \
  -e POSTGRES_USER=anno \
  -e POSTGRES_PASSWORD=password postgres:15

# Verify services are running
docker ps
curl http://localhost:7474  # Neo4j web interface
redis-cli ping              # Redis connectivity
```

### 6. Database Initialization

```bash
# Initialize knowledge graph schema
npm run db:migrate:neo4j

# Create PostgreSQL tables
npm run db:migrate:postgres

# Seed development data
npm run db:seed

# Verify database setup
npm run db:health-check
```

### 7. Verify Installation

```bash
# Run development server
npm run dev

# In another terminal, run health checks
curl http://localhost:5213/health
curl http://localhost:5213/v1/system/status

# Run agent worker
npm run dev:agents

# Run integration tests
npm run test:integration
```

---

## Development Workflow

### Daily Development Process

```bash
# 1. Update codebase
git pull origin main
npm install  # If package.json changed
pip install -r requirements.txt  # If requirements changed

# 2. Start development environment
npm run dev:services  # Start all services
npm run dev           # Start main application
npm run dev:agents    # Start agent workers (separate terminal)

# 3. Make changes and test
npm run test:watch    # Continuous testing
npm run lint:fix      # Auto-fix linting issues

# 4. Commit changes
git add .
git commit -m "feat(layer-x): description of changes"
git push origin feature-branch-name
```

### Branch Management

```bash
# Create feature branch
git checkout main
git pull origin main
git checkout -b feature/layer-a-improvements

# Work on changes...

# Before committing
npm run pre-commit  # Runs linting, tests, type checking

# Commit with conventional format
git commit -m "feat(transport): add QUIC fallback mechanism

- Implement automatic fallback from QUIC to HTTP/2
- Add connection timeout handling
- Update transport manager tests

Closes #123"

# Push and create PR
git push origin feature/layer-a-improvements
```

### Code Generation

```bash
# Generate API client from OpenAPI spec
npm run generate:api-client

# Generate database migrations
npm run generate:migration -- --name add_confidence_scoring

# Generate agent templates
npm run generate:agent -- --name financial-analysis-agent

# Generate test fixtures
npm run generate:fixtures -- --type research-data
```

---

## Testing Framework

### Test Categories

#### 1. Unit Tests

```bash
# Run all unit tests
npm run test:unit

# Run specific layer tests
npm run test:unit -- --grep "Layer A"
npm run test:unit -- src/core/transport

# Run with coverage
npm run test:unit:coverage

# Watch mode during development
npm run test:watch
```

**Example Unit Test**:
```typescript
// tests/unit/core/transport/transport-manager.test.ts
import { TransportManager } from '../../../../src/core/transport';
import { mockFetch } from '../../../helpers/mock-fetch';

describe('TransportManager', () => {
  let transportManager: TransportManager;

  beforeEach(() => {
    transportManager = new TransportManager({
      timeout: 5000,
      retries: 3
    });
  });

  describe('fetch', () => {
    it('should successfully fetch content with QUIC', async () => {
      // Arrange
      const mockContent = '<html><body>Test content</body></html>';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mockContent),
        headers: new Headers({ 'content-type': 'text/html' })
      });

      // Act
      const result = await transportManager.fetch('https://example.com');

      // Assert
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe(mockContent);
      expect(result.contentType).toBe('text/html');
    });

    it('should fallback to HTTP/2 when QUIC fails', async () => {
      // Test implementation
    });

    it('should handle network timeouts gracefully', async () => {
      // Test implementation
    });
  });
});
```

#### 2. Integration Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific integration suite
npm run test:integration -- --grep "Multi-Agent"

# Run with real external services
npm run test:integration:real-services
```

**Example Integration Test**:
```typescript
// tests/integration/research-workflow.test.ts
import { AnnoClient } from '../../src/client';
import { setupTestEnvironment, cleanupTestEnvironment } from '../helpers/test-env';

describe('Research Workflow Integration', () => {
  let client: AnnoClient;

  beforeAll(async () => {
    await setupTestEnvironment();
    client = new AnnoClient({
      endpoint: 'http://localhost:5213',
      apiKey: 'test-api-key'
    });
  });

  afterAll(async () => {
    await cleanupTestEnvironment();
  });

  it('should complete end-to-end research task', async () => {
    // Arrange
    const researchQuery = {
      question: 'What are recent advances in quantum computing?',
      depth: 'comprehensive' as const,
      maxSources: 5
    };

    // Act
    const result = await client.research.query(researchQuery);

    // Assert
    expect(result.answer).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.sources).toHaveLength(5);
    expect(result.evidence.length).toBeGreaterThan(0);
  }, 60000);
});
```

#### 3. End-to-End Tests

```bash
# Run E2E tests with Playwright
npm run test:e2e

# Run specific E2E test
npm run test:e2e -- tests/e2e/research-dashboard.spec.ts

# Run E2E tests in different browsers
npm run test:e2e:chromium
npm run test:e2e:firefox
npm run test:e2e:webkit
```

#### 4. Performance Tests

```bash
# Run load tests
npm run test:load

# Run specific performance test
npm run test:perf -- --scenario content-extraction

# Generate performance report
npm run test:perf:report
```

**Example Performance Test**:
```typescript
// tests/performance/content-extraction.perf.ts
import { performance } from 'perf_hooks';
import { ContentExtractor } from '../../src/core/content';

describe('Content Extraction Performance', () => {
  it('should extract content within performance limits', async () => {
    const extractor = new ContentExtractor();
    const testHTML = await loadTestHTML('large-article.html');

    const startTime = performance.now();

    const result = await extractor.extract(testHTML, {
      url: 'https://example.com/article',
      distillContent: true
    });

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Performance assertions
    expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    expect(result.confidence).toBeGreaterThan(0.8);

    // Memory usage check
    const memoryUsage = process.memoryUsage();
    expect(memoryUsage.heapUsed).toBeLessThan(100 * 1024 * 1024); // Under 100MB
  });
});
```

#### 5. Benchmark Tests

```bash
# Run benchmarks against baselines
npm run benchmark

# Run specific benchmarks
npm run benchmark -- token-efficiency
npm run benchmark -- agent-performance

# Compare with previous versions
npm run benchmark:compare -- --baseline v1.0.0
```

### Test Data Management

```bash
# Generate test datasets
npm run test:generate-data

# Update test fixtures
npm run test:update-fixtures

# Clean test databases
npm run test:clean-db

# Reset test environment
npm run test:reset
```

### Mocking External Services

```typescript
// tests/helpers/mock-services.ts
export const mockWikidataService = {
  search: jest.fn(),
  getEntity: jest.fn(),
  query: jest.fn()
};

export const mockOpenAIService = {
  createCompletion: jest.fn(),
  createEmbedding: jest.fn()
};

// In tests
beforeEach(() => {
  mockWikidataService.search.mockResolvedValue({
    results: [
      { id: 'Q60', label: 'New York City', score: 0.95 }
    ]
  });
});
```

---

## Debugging Guide

### Application Debugging

```bash
# Start with debugging enabled
DEBUG=anno:* npm run dev

# Debug specific layers
DEBUG=anno:transport,anno:agents npm run dev

# Node.js debugging with inspector
node --inspect=0.0.0.0:9229 dist/server.js

# Python debugging
python -m pdb src/agent/worker.py
```

### VS Code Launch Configuration

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Anno Core",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/src/server.ts",
      "env": {
        "NODE_ENV": "development",
        "DEBUG": "anno:*"
      },
      "console": "integratedTerminal",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    },
    {
      "name": "Debug Tests",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": ["--runInBand", "${file}"],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

### Database Debugging

```bash
# Redis debugging
redis-cli monitor  # Watch all Redis commands

# Neo4j debugging
docker exec -it neo4j cypher-shell -u neo4j -p password
# Then run Cypher queries

# PostgreSQL debugging
docker exec -it postgres psql -U anno -d anno_dev
```

### Agent Debugging

```bash
# Enable agent debugging
export DEBUG_AGENTS=true
export AGENT_LOG_LEVEL=debug

# Run single agent in debug mode
npm run debug:agent -- academic-research-agent

# View agent metrics
curl http://localhost:8081/debug/agents
curl http://localhost:8081/debug/tasks
```

---

## Code Quality Tools

### Linting

```bash
# TypeScript/JavaScript
npm run lint              # Check for issues
npm run lint:fix          # Auto-fix issues
npx eslint src/ --ext .ts,.js

# Python
flake8 src/
black src/ --check
isort src/ --check-only

# Fix Python formatting
black src/
isort src/
```

### Type Checking

```bash
# TypeScript
npm run type-check
npx tsc --noEmit

# Python
mypy src/
```

### Code Coverage

```bash
# Generate coverage report
npm run test:coverage

# View coverage report
open coverage/lcov-report/index.html

# Coverage thresholds
npm run test:coverage -- --threshold-global 90
```

### Security Scanning

```bash
# Dependency vulnerability scanning
npm audit
npm audit fix

# Python security scanning
pip-audit
bandit -r src/

# Docker image scanning
docker scout quickview anno/core:latest
```

### Code Metrics

```bash
# Complexity analysis
npm run analyze:complexity

# Bundle analysis
npm run analyze:bundle

# Performance profiling
npm run profile:memory
npm run profile:cpu
```

---

## Local Services

### Service Management

```yaml
# docker-compose.dev.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data

  neo4j:
    image: neo4j:5
    ports:
      - "7474:7474"
      - "7687:7687"
    environment:
      - NEO4J_AUTH=neo4j/password
      - NEO4J_dbms_default__database=anno
    volumes:
      - neo4j_data:/data

  postgres:
    image: postgres:15
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=anno_dev
      - POSTGRES_USER=anno
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./config/prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana

volumes:
  redis_data:
  neo4j_data:
  postgres_data:
  grafana_data:
```

### Service Health Checks

```bash
# Check all services
npm run services:health

# Individual service checks
npm run check:redis
npm run check:neo4j
npm run check:postgres

# Service logs
docker-compose logs -f redis
docker-compose logs -f neo4j
```

---

## IDE Configuration

### VS Code Extensions

```json
// .vscode/extensions.json
{
  "recommendations": [
    "ms-vscode.vscode-typescript-next",
    "esbenp.prettier-vscode",
    "ms-python.python",
    "ms-python.pylint",
    "bradlc.vscode-tailwindcss",
    "ms-vscode.vscode-json",
    "redhat.vscode-yaml",
    "ms-kubernetes-tools.vscode-kubernetes-tools",
    "ms-vscode-remote.remote-containers"
  ]
}
```

### VS Code Settings

```json
// .vscode/settings.json
{
  "typescript.preferences.importModuleSpecifier": "relative",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true,
    "source.organizeImports": true
  },
  "python.defaultInterpreterPath": "./venv/bin/python",
  "python.formatting.provider": "black",
  "python.linting.enabled": true,
  "python.linting.pylintEnabled": true,
  "files.exclude": {
    "**/node_modules": true,
    "**/.git": true,
    "**/dist": true,
    "**/__pycache__": true,
    "**/venv": true
  }
}
```

### IntelliJ/WebStorm Configuration

```xml
<!-- .idea/runConfigurations/Debug_Anno.xml -->
<configuration name="Debug Anno" type="NodeJSConfigurationType">
  <option name="workingDirectory" value="$PROJECT_DIR$" />
  <option name="javascriptFile" value="$PROJECT_DIR$/dist/server.js" />
  <envs>
    <env name="NODE_ENV" value="development" />
    <env name="DEBUG" value="anno:*" />
  </envs>
  <option name="enableDebugging" value="true" />
</configuration>
```

### Git Configuration

```bash
# Set up useful git aliases
git config alias.st status
git config alias.co checkout
git config alias.br branch
git config alias.up '!git fetch && git rebase origin/main'
git config alias.logs 'log --oneline --graph --decorate'

# Set up commit message template
git config commit.template .gitmessage.txt
```

### Shell Configuration

```bash
# Add to ~/.bashrc or ~/.zshrc
export NEUROSURF_DEV=1
export PATH="$PATH:./node_modules/.bin"

# Useful aliases
alias ns-dev='npm run dev'
alias ns-test='npm run test:watch'
alias ns-logs='docker-compose logs -f'
alias ns-reset='npm run test:reset && npm run services:restart'

# Auto-completion for npm scripts
if command -v npm > /dev/null 2>&1; then
  eval "$(npm completion)"
fi
```

This developer setup guide ensures you have everything needed for productive Anno development with proper testing, debugging, and code quality practices.