# Anno Enterprise Platform

> **Future-Proof, Modular, Dynamic, and Consistent Multi-Tenant API Platform**

A complete enterprise-grade platform for scaling Anno from a single private instance to serving hundreds of enterprise clients with full security, compliance, and monitoring capabilities.

## 🚀 Quick Start

### 1. Deploy the Platform

```bash
# Clone and navigate to platform
cd platform

# Deploy everything with one command
./deploy.sh deploy

# Or deploy to specific environment
ENVIRONMENT=production DOMAIN=api.yourcompany.com ./deploy.sh deploy
```

### 2. Access Your Platform

- **API Gateway**: `https://api.anno.local` (or your custom domain)
- **Grafana Dashboard**: `http://localhost:3001` (admin / generated password)
- **Prometheus Metrics**: `http://localhost:9091`
- **Kibana Logs**: `http://localhost:5601`
- **Jaeger Tracing**: `http://localhost:16686`

### 3. Create Your First Tenant

```bash
# Create tenant via API
curl -X POST https://api.anno.local/v1/tenants \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: admin-key-123" \
  -d '{
    "companyName": "Your Company",
    "companyDomain": "yourcompany.com",
    "contactEmail": "admin@yourcompany.com"
  }'
```

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Enterprise Anno Platform                     │
├─────────────────────────────────────────────────────────────────┤
│  Client Apps (SDK) → API Gateway → Tenant Router → Anno Core   │
│                     ↓              ↓              ↓            │
│  Monitoring ← Auth Service ← Config Service ← Processing Pool  │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

- **API Gateway**: Nginx-based gateway with authentication, rate limiting, and load balancing
- **Auth Service**: Multi-tenant authentication, API key management, and RBAC
- **Anno Core**: Scalable processing instances with tenant isolation
- **Config Service**: Dynamic configuration and feature flags
- **Monitoring Service**: Comprehensive observability and alerting
- **Database Layer**: PostgreSQL with tenant-specific schemas
- **Cache Layer**: Redis with namespaced caching
- **Message Queue**: Redis-based job processing

## 🔧 Configuration

### Environment Variables

The platform uses a comprehensive `.env` file generated during deployment:

```bash
# Core Configuration
ENVIRONMENT=staging
DOMAIN=api.anno.local
REGION=us-east-1

# Security
JWT_SECRET=generated-secure-secret
ENCRYPTION_KEY=generated-encryption-key
BILLING_WEBHOOK_SECRET=generated-webhook-secret

# Database
POSTGRES_PASSWORD=generated-password
AUTH_DB_PASSWORD=generated-password
# ... more database passwords

# Monitoring
GRAFANA_PASSWORD=generated-password

# AWS (optional)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
BACKUP_S3_BUCKET=your-backup-bucket
```

### SSL Certificates

For production, replace the self-signed certificates:

```bash
# Place your certificates in platform/ssl/
cp your-cert.crt platform/ssl/api.anno.local.crt
cp your-key.key platform/ssl/api.anno.local.key
```

## 📊 Monitoring & Observability

### Metrics

The platform exposes comprehensive metrics:

- **Request metrics**: Rate, latency, errors per tenant
- **Resource metrics**: CPU, memory, disk usage
- **Business metrics**: Token reduction ratios, processing volumes
- **Security metrics**: Failed authentications, rate limit hits

### Dashboards

Pre-configured Grafana dashboards:

- **Platform Overview**: System health and performance
- **Tenant Analytics**: Usage patterns and billing metrics
- **Security Monitoring**: Authentication and authorization events
- **Performance Analysis**: Response times and throughput

### Alerting

Automated alerts for:

- High error rates (>5% for 2 minutes)
- Rate limit violations
- Service downtime
- Resource exhaustion
- Security incidents

## 🔐 Security Features

### Multi-Layer Security

1. **Network Security**: VPC isolation, firewall rules
2. **Authentication**: API key-based with JWT validation
3. **Authorization**: Role-based access control (RBAC)
4. **Encryption**: TLS in transit, AES-256 at rest
5. **Audit Logging**: Comprehensive activity tracking
6. **Rate Limiting**: Per-tenant and per-API-key limits

### Compliance

- **GDPR**: Data residency and privacy controls
- **SOC 2**: Audit logging and access controls
- **HIPAA**: Encryption and access logging (enterprise tier)

## 🚀 Scaling & Performance

### Auto-Scaling

- **Horizontal**: Automatic scaling based on CPU, memory, and request rate
- **Vertical**: Resource optimization based on workload patterns
- **Geographic**: Multi-region deployment support

### Caching Strategy

- **L1 Cache**: In-memory LRU cache (fastest)
- **L2 Cache**: Redis distributed cache (fast)
- **L3 Cache**: Database persistent cache (slowest)

### Load Balancing

- **Round Robin**: Even distribution across instances
- **Least Connections**: Dynamic load balancing
- **Tenant Affinity**: Sticky sessions for enterprise clients

## 💼 Client SDK Usage

### Installation

```bash
npm install @anno/platform-client
```

### Basic Usage

```typescript
import { AnnoClient } from '@anno/platform-client';

const client = new AnnoClient({
  apiKey: 'anno_your_api_key_here',
  baseURL: 'https://api.anno.local'
});

// Fetch single URL
const result = await client.fetch({
  url: 'https://example.com',
  options: {
    render: true,
    maxNodes: 50,
    useCache: true
  }
});

console.log(`Extracted ${result.nodes.length} semantic nodes`);
console.log(`Confidence: ${result.confidence}`);
```

### Batch Processing

```typescript
// Process multiple URLs
const batchResult = await client.batchFetch({
  urls: [
    'https://example.com/page1',
    'https://example.com/page2',
    'https://example.com/page3'
  ],
  options: {
    parallel: 3,
    maxNodes: 50
  }
});

console.log(`Processed ${batchResult.successfulUrls}/${batchResult.totalUrls} URLs`);
```

### Streaming with Progress

```typescript
// Real-time processing updates
const result = await client.streamFetch({
  url: 'https://example.com',
  options: { render: true }
}, (message) => {
  if (message.type === 'progress') {
    console.log(`Progress: ${message.payload.percentage}%`);
  }
});
```

### Usage Monitoring

```typescript
// Check tenant limits and usage
const tenantInfo = await client.getTenantInfo();
console.log(`Plan: ${tenantInfo.plan}`);
console.log(`Requests today: ${tenantInfo.usage.requestsPerDay}`);

const usageStats = await client.getUsageStats('day');
console.log(`Storage used: ${usageStats.storageUsedGB}GB / ${usageStats.limits.storageQuotaGB}GB`);
```

## 🔄 Deployment Commands

```bash
# Deploy platform
./deploy.sh deploy

# View logs
./deploy.sh logs [service-name]

# Check status
./deploy.sh status

# Restart service
./deploy.sh restart [service-name]

# Scale service
./deploy.sh scale anno-core-1 5

# Cleanup everything
./deploy.sh cleanup

# Get help
./deploy.sh help
```

## 📈 Pricing Tiers

### Trial (Free)
- 1,000 requests/month
- Basic extraction features
- 7-day data retention
- Community support

### Starter ($99/month)
- 100,000 requests/month
- Batch processing
- 30-day data retention
- Email support

### Professional ($499/month)
- 1,000,000 requests/month
- Custom models
- Priority processing
- 90-day data retention
- Priority support

### Enterprise (Custom)
- Unlimited requests
- Custom deployment
- Dedicated support
- SLA guarantee
- Custom compliance

## 🛠️ Development

### Adding New Services

1. Create service directory: `platform/new-service/`
2. Add Dockerfile and source code
3. Update `docker-compose.yml`
4. Add monitoring configuration
5. Update deployment scripts

### Customizing Configuration

1. Modify service-specific config files
2. Update environment variables in `.env`
3. Rebuild and redeploy: `./deploy.sh deploy`

### Testing

```bash
# Run integration tests
npm test

# Test specific service
docker-compose exec auth-service npm test

# Load testing
npm run load-test
```

## 📚 API Documentation

### Authentication

All API requests require an API key:

```bash
curl -H "Authorization: Bearer your_api_key" https://api.anno.local/v1/content/fetch
```

### Rate Limits

Rate limits are enforced per tenant and per API key:

- **Trial**: 10 requests/minute, 1,000/day
- **Starter**: 60 requests/minute, 10,000/day
- **Professional**: 300 requests/minute, 100,000/day
- **Enterprise**: 1,000 requests/minute, unlimited

### Error Handling

Standard HTTP status codes with detailed error messages:

```json
{
  "error": "rate_limit_exceeded",
  "message": "Request rate limit exceeded",
  "retry_after": 60,
  "limits": {
    "requests_per_minute": 60,
    "current_usage": 65
  }
}
```

## 🔧 Troubleshooting

### Common Issues

1. **Services won't start**: Check Docker daemon and ports
2. **SSL errors**: Verify certificate paths and permissions
3. **Database connection**: Check PostgreSQL credentials
4. **Rate limiting**: Verify tenant limits and usage

### Debug Mode

Enable debug logging:

```bash
# Set debug environment variable
export DEBUG=true

# Or modify .env file
echo "DEBUG=true" >> .env

# Restart services
./deploy.sh restart
```

### Logs

View detailed logs:

```bash
# All services
./deploy.sh logs

# Specific service
./deploy.sh logs auth-service

# Follow logs in real-time
docker-compose logs -f api-gateway
```

## 📞 Support

- **Documentation**: [docs.anno.ai](https://docs.anno.ai)
- **GitHub Issues**: [github.com/evo-hydra/anno/issues](https://github.com/evo-hydra/anno/issues)
- **Enterprise Support**: enterprise@anno.ai
- **Community Discord**: [discord.gg/anno](https://discord.gg/anno)

## 📄 License

**Proprietary and Confidential** - Copyright (c) 2025 evo-hydra. All rights reserved.

This enterprise platform is proprietary technology. No license is granted for use, reproduction, or distribution without explicit written permission.

---

**Anno Enterprise Platform: Where Web meets Intelligence at Scale** 🌐🧠⚡
