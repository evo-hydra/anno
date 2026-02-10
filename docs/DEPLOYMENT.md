# Anno Deployment Guide

This guide covers production deployment, infrastructure requirements, and operational procedures for Anno.

## Quick Start Deployment

### Docker Compose (Development)

```bash
# Clone repository
git clone https://github.com/your-org/anno.git
cd anno

# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f anno-core
```

### Kubernetes (Production)

```bash
# Apply configurations
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/secrets/
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/services/
kubectl apply -f k8s/ingress/

# Check status
kubectl get pods -n anno
```

## Infrastructure Requirements

### Minimum Production Setup

```yaml
Compute:
  - 3x Application Servers: 8 vCPU, 16GB RAM
  - 2x Agent Workers: 16 vCPU, 32GB RAM
  - 1x Load Balancer: 4 vCPU, 8GB RAM

Storage:
  - Knowledge Graph: 1TB SSD, 3000 IOPS
  - Content Cache: 2TB SSD, 1000 IOPS
  - Logs/Metrics: 500GB Standard

Network:
  - Bandwidth: 1Gbps
  - CDN: Global edge locations
  - SSL/TLS: Wildcard certificates

Databases:
  - Redis Cluster: 3 nodes, 32GB RAM each
  - Neo4j Cluster: 3 nodes, 64GB RAM each
  - PostgreSQL: Master/Replica, 16GB RAM each
```

### Cloud Provider Specifications

#### AWS Deployment

```yaml
Compute:
  - EC2 Instances: c5.2xlarge (app), c5.4xlarge (workers)
  - ECS/EKS: For container orchestration
  - Application Load Balancer: For traffic distribution

Storage:
  - EBS GP3: For application storage
  - EFS: For shared file storage
  - S3: For content cache and backups

Database:
  - ElastiCache Redis: Multi-AZ cluster
  - RDS PostgreSQL: Multi-AZ deployment
  - EC2 for Neo4j: Custom clustering

Monitoring:
  - CloudWatch: Metrics and logs
  - X-Ray: Distributed tracing
  - VPC Flow Logs: Network monitoring
```

#### GCP Deployment

```yaml
Compute:
  - Compute Engine: n2-standard-8 (app), n2-standard-16 (workers)
  - GKE: For Kubernetes orchestration
  - Load Balancer: Global HTTP(S) Load Balancing

Storage:
  - Persistent Disks: SSD for performance
  - Cloud Storage: For content cache
  - Filestore: For shared storage

Database:
  - Memorystore Redis: For caching
  - Cloud SQL PostgreSQL: Managed database
  - Compute Engine: Custom Neo4j setup

Monitoring:
  - Cloud Monitoring: Metrics and alerting
  - Cloud Logging: Centralized logging
  - Cloud Trace: Request tracing
```

## Container Images

### Core Service Dockerfile

```dockerfile
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

FROM node:18-alpine AS runtime

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 5213
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5213/health || exit 1

USER node
CMD ["node", "dist/server.js"]
```

### Agent Worker Dockerfile

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ src/
COPY config/ config/

ENV PYTHONPATH=/app
ENV WORKER_TYPE=agent

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:8081/health')"

CMD ["python", "-m", "src.agent.worker"]
```

## Kubernetes Manifests

### Namespace

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: anno
  labels:
    name: anno
```

### Core Deployment

```yaml
# k8s/deployments/core.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: anno-core
  namespace: anno
spec:
  replicas: 3
  selector:
    matchLabels:
      app: anno-core
  template:
    metadata:
      labels:
        app: anno-core
    spec:
      containers:
      - name: core
        image: anno/core:latest
        ports:
        - containerPort: 5213
        env:
        - name: NODE_ENV
          value: "production"
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: anno-secrets
              key: redis-url
        - name: NEO4J_URL
          valueFrom:
            secretKeyRef:
              name: anno-secrets
              key: neo4j-url
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 5213
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /ready
            port: 5213
          initialDelaySeconds: 30
          periodSeconds: 10
        volumeMounts:
        - name: config
          mountPath: /app/config
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: anno-config
```

### Agent Worker Deployment

```yaml
# k8s/deployments/agents.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: anno-agents
  namespace: anno
spec:
  replicas: 5
  selector:
    matchLabels:
      app: anno-agents
  template:
    metadata:
      labels:
        app: anno-agents
    spec:
      containers:
      - name: agent-worker
        image: anno/agents:latest
        ports:
        - containerPort: 8081
        env:
        - name: WORKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: anno-secrets
              key: redis-url
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 8081
          initialDelaySeconds: 60
          periodSeconds: 30
```

### Services

```yaml
# k8s/services/core.yaml
apiVersion: v1
kind: Service
metadata:
  name: anno-core-service
  namespace: anno
spec:
  selector:
    app: anno-core
  ports:
  - protocol: TCP
    port: 80
    targetPort: 5213
  type: ClusterIP

---
apiVersion: v1
kind: Service
metadata:
  name: anno-agents-service
  namespace: anno
spec:
  selector:
    app: anno-agents
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8081
  type: ClusterIP
```

### Ingress

```yaml
# k8s/ingress/main.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: anno-ingress
  namespace: anno
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
spec:
  tls:
  - hosts:
    - api.anno.ai
    secretName: anno-tls
  rules:
  - host: api.anno.ai
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: anno-core-service
            port:
              number: 80
```

## Configuration Management

### Environment Variables

```bash
# Core Service Environment Variables
NODE_ENV=production
PORT=5213
LOG_LEVEL=info

# Database Configuration
REDIS_URL=redis://redis-cluster:6379
NEO4J_URL=bolt://neo4j-cluster:7687
POSTGRES_URL=postgresql://postgres:5432/anno

# External Services
OPENAI_API_KEY=sk-...
WIKIDATA_ENDPOINT=https://query.wikidata.org/sparql

# Security
JWT_SECRET=your-jwt-secret
API_RATE_LIMIT=1000
CORS_ORIGINS=https://app.anno.ai,https://dashboard.anno.ai

# Performance
WORKER_PROCESSES=4
CACHE_TTL=3600
MAX_CONCURRENT_REQUESTS=100

# Monitoring
METRICS_ENABLED=true
TRACING_ENABLED=true
DATADOG_API_KEY=your-datadog-key
```

### ConfigMap

```yaml
# k8s/configmaps/app-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: anno-config
  namespace: anno
data:
  app.yaml: |
    server:
      port: 5213
      cors:
        origins:
          - https://app.anno.ai
          - https://dashboard.anno.ai

    layers:
      transport:
        timeoutMs: 30000
        maxRedirects: 5
        userAgent: "Anno/1.0"

      agents:
        maxConcurrent: 50
        defaultTimeout: 60000
        retryAttempts: 3

      semantic:
        confidenceThreshold: 0.8
        maxEntitiesPerPage: 1000

    monitoring:
      metrics:
        enabled: true
        interval: 30
      tracing:
        enabled: true
        samplingRate: 0.1
```

### Secrets

```yaml
# k8s/secrets/app-secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: anno-secrets
  namespace: anno
type: Opaque
data:
  redis-url: cmVkaXM6Ly9yZWRpcy1jbHVzdGVyOjYzNzk=  # base64 encoded
  neo4j-url: Ym9sdDovL25lbzRqLWNsdXN0ZXI6NzY4Nw==   # base64 encoded
  postgres-url: cG9zdGdyZXNxbDovL3Bvc3RncmVzOjU0MzIvbmV1cm9zdXJm  # base64 encoded
  openai-api-key: c2stLi4u  # base64 encoded
  jwt-secret: eW91ci1qd3Qtc2VjcmV0  # base64 encoded
```

## Database Setup

### Redis Cluster

```yaml
# k8s/deployments/redis-cluster.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: anno
spec:
  serviceName: redis-cluster
  replicas: 6
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
        - containerPort: 16379
        command:
        - redis-server
        - /etc/redis/redis.conf
        - --cluster-enabled
        - "yes"
        - --cluster-config-file
        - nodes.conf
        - --cluster-node-timeout
        - "5000"
        - --appendonly
        - "yes"
        volumeMounts:
        - name: redis-data
          mountPath: /data
        - name: redis-config
          mountPath: /etc/redis
  volumeClaimTemplates:
  - metadata:
      name: redis-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 100Gi
```

### Neo4j Cluster

```yaml
# k8s/deployments/neo4j.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: neo4j-cluster
  namespace: anno
spec:
  serviceName: neo4j-cluster
  replicas: 3
  selector:
    matchLabels:
      app: neo4j-cluster
  template:
    metadata:
      labels:
        app: neo4j-cluster
    spec:
      containers:
      - name: neo4j
        image: neo4j:5-enterprise
        ports:
        - containerPort: 7474
        - containerPort: 7687
        env:
        - name: NEO4J_AUTH
          value: "neo4j/your-password"
        - name: NEO4J_dbms_mode
          value: "CORE"
        - name: NEO4J_causal__clustering_minimum__core__cluster__size__at__formation
          value: "3"
        - name: NEO4J_causal__clustering_initial__discovery__members
          value: "neo4j-cluster-0.neo4j-cluster:5000,neo4j-cluster-1.neo4j-cluster:5000,neo4j-cluster-2.neo4j-cluster:5000"
        volumeMounts:
        - name: neo4j-data
          mountPath: /data
        resources:
          requests:
            cpu: 2000m
            memory: 8Gi
          limits:
            cpu: 4000m
            memory: 16Gi
  volumeClaimTemplates:
  - metadata:
      name: neo4j-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 500Gi
```

## Monitoring & Observability

### Prometheus Configuration

```yaml
# k8s/monitoring/prometheus.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: anno
data:
  prometheus.yml: |
    global:
      scrape_interval: 30s
      evaluation_interval: 30s

    rule_files:
      - /etc/prometheus/rules/*.yml

    scrape_configs:
    - job_name: 'anno-core'
      static_configs:
      - targets: ['anno-core-service:80']
      metrics_path: /metrics
      scrape_interval: 15s

    - job_name: 'anno-agents'
      static_configs:
      - targets: ['anno-agents-service:80']
      metrics_path: /metrics
      scrape_interval: 15s

    - job_name: 'redis'
      static_configs:
      - targets: ['redis-cluster:6379']

    - job_name: 'neo4j'
      static_configs:
      - targets: ['neo4j-cluster:7474']

    alerting:
      alertmanagers:
      - static_configs:
        - targets:
          - alertmanager:9093
```

### Grafana Dashboards

```json
{
  "dashboard": {
    "title": "Anno System Overview",
    "panels": [
      {
        "title": "Request Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total[5m])) by (service)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Response Time",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))",
            "legendFormat": "95th percentile"
          }
        ]
      },
      {
        "title": "Agent Tasks",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(agent_tasks_completed_total) by (agent_type)",
            "legendFormat": "{{agent_type}}"
          }
        ]
      }
    ]
  }
}
```

### Alerting Rules

```yaml
# k8s/monitoring/alerts.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-alerts
  namespace: anno
data:
  alerts.yml: |
    groups:
    - name: anno-alerts
      rules:
      - alert: HighErrorRate
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: High error rate detected

      - alert: HighResponseTime
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: High response time detected

      - alert: AgentQueueBacklog
        expr: agent_queue_size > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Agent queue backlog is high

      - alert: KnowledgeGraphDown
        expr: up{job="neo4j"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: Neo4j knowledge graph is down
```

## Security

### Network Security

```yaml
# k8s/network-policies/default-deny.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: anno
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress

---
# Allow core service to communicate with databases
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-core-to-databases
  namespace: anno
spec:
  podSelector:
    matchLabels:
      app: anno-core
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: redis-cluster
    ports:
    - protocol: TCP
      port: 6379
  - to:
    - podSelector:
        matchLabels:
          app: neo4j-cluster
    ports:
    - protocol: TCP
      port: 7687
```

### RBAC Configuration

```yaml
# k8s/rbac/service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: anno-app
  namespace: anno

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: anno-role
  namespace: anno
rules:
- apiGroups: [""]
  resources: ["pods", "services", "configmaps"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: anno-rolebinding
  namespace: anno
subjects:
- kind: ServiceAccount
  name: anno-app
  namespace: anno
roleRef:
  kind: Role
  name: anno-role
  apiGroup: rbac.authorization.k8s.io
```

## Backup & Recovery

### Database Backups

```bash
#!/bin/bash
# scripts/backup.sh

# Neo4j backup
kubectl exec neo4j-cluster-0 -n anno -- \
  neo4j-admin backup --backup-dir=/backups \
  --name=graph-$(date +%Y%m%d-%H%M%S) \
  --from=localhost:6362

# Redis backup
kubectl exec redis-cluster-0 -n anno -- \
  redis-cli --rdb /backups/redis-$(date +%Y%m%d-%H%M%S).rdb

# Upload to cloud storage
aws s3 sync /backups s3://anno-backups/$(date +%Y/%m/%d)/
```

### Disaster Recovery

```yaml
# Recovery playbook
recovery_procedures:
  rto: 15 minutes  # Recovery Time Objective
  rpo: 5 minutes   # Recovery Point Objective

  steps:
    1. Assess damage and determine scope
    2. Spin up new infrastructure if needed
    3. Restore databases from latest backups
    4. Deploy application services
    5. Update DNS to point to new infrastructure
    6. Validate system functionality
    7. Monitor for stability

  automation:
    - Terraform for infrastructure provisioning
    - Helm charts for application deployment
    - Automated backup restoration scripts
    - Health check validation
```

This deployment guide provides production-ready configurations for scaling Anno from development to enterprise deployment scenarios.