#!/bin/bash

# Enterprise Anno Platform Deployment Script
# Future-Proof, Modular, Dynamic, and Consistent deployment automation

set -euo pipefail

# Configuration
PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$PLATFORM_DIR")"
ENVIRONMENT="${ENVIRONMENT:-staging}"
DOMAIN="${DOMAIN:-api.anno.local}"
REGION="${REGION:-us-east-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    local missing_tools=()
    
    # Check for required tools
    command -v docker >/dev/null 2>&1 || missing_tools+=("docker")
    command -v docker-compose >/dev/null 2>&1 || missing_tools+=("docker-compose")
    command -v openssl >/dev/null 2>&1 || missing_tools+=("openssl")
    command -v curl >/dev/null 2>&1 || missing_tools+=("curl")
    
    if [ ${#missing_tools[@]} -ne 0 ]; then
        log_error "Missing required tools: ${missing_tools[*]}"
        log_error "Please install the missing tools and try again."
        exit 1
    fi
    
    # Check Docker daemon
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker daemon is not running. Please start Docker and try again."
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Generate environment file
generate_env_file() {
    log_info "Generating environment configuration..."
    
    local env_file="$PLATFORM_DIR/.env"
    
    if [ -f "$env_file" ]; then
        log_warning "Environment file already exists. Backing up to .env.backup"
        cp "$env_file" "$env_file.backup"
    fi
    
    # Generate secure passwords
    local postgres_password=$(openssl rand -base64 32)
    local redis_password=$(openssl rand -base64 32)
    local jwt_secret=$(openssl rand -base64 64)
    local encryption_key=$(openssl rand -base64 32)
    local grafana_password=$(openssl rand -base64 16)
    
    cat > "$env_file" << EOF
# Environment Configuration
ENVIRONMENT=${ENVIRONMENT}
DOMAIN=${DOMAIN}
REGION=${REGION}

# Database Passwords
POSTGRES_PASSWORD=${postgres_password}
AUTH_DB_PASSWORD=$(openssl rand -base64 32)
CORE_DB_PASSWORD=$(openssl rand -base64 32)
CONFIG_DB_PASSWORD=$(openssl rand -base64 32)
MONITORING_DB_PASSWORD=$(openssl rand -base64 32)
SECURITY_DB_PASSWORD=$(openssl rand -base64 32)

# Redis Configuration
REDIS_PASSWORD=${redis_password}

# Security Keys
JWT_SECRET=${jwt_secret}
ENCRYPTION_KEY=${encryption_key}
BILLING_WEBHOOK_SECRET=$(openssl rand -base64 32)

# Monitoring
GRAFANA_PASSWORD=${grafana_password}

# AWS Configuration (if using S3 for backups)
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}
BACKUP_S3_BUCKET=${BACKUP_S3_BUCKET:-}

# SSL Configuration
SSL_CERT_PATH=./ssl/api.anno.local.crt
SSL_KEY_PATH=./ssl/api.anno.local.key
EOF
    
    log_success "Environment file generated: $env_file"
    log_warning "Please review and update the environment file as needed"
}

# Generate SSL certificates
generate_ssl_certificates() {
    log_info "Generating SSL certificates..."
    
    local ssl_dir="$PLATFORM_DIR/ssl"
    mkdir -p "$ssl_dir"
    
    if [ -f "$ssl_dir/api.anno.local.crt" ] && [ -f "$ssl_dir/api.anno.local.key" ]; then
        log_warning "SSL certificates already exist. Skipping generation."
        return
    fi
    
    # Generate self-signed certificate for local development
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$ssl_dir/api.anno.local.key" \
        -out "$ssl_dir/api.anno.local.crt" \
        -subj "/C=US/ST=CA/L=San Francisco/O=Anno/OU=Platform/CN=api.anno.local" \
        -addext "subjectAltName=DNS:api.anno.local,DNS:localhost,IP:127.0.0.1"
    
    log_success "SSL certificates generated"
}

# Initialize database
initialize_database() {
    log_info "Initializing database..."
    
    # Create database initialization scripts
    local init_dir="$PLATFORM_DIR/database/init"
    mkdir -p "$init_dir"
    
    cat > "$init_dir/01-create-databases.sql" << 'EOF'
-- Create databases for different services
CREATE DATABASE anno_auth;
CREATE DATABASE anno_core;
CREATE DATABASE anno_config;
CREATE DATABASE anno_monitoring;
CREATE DATABASE anno_security;

-- Create users for each service
CREATE USER anno_auth WITH PASSWORD '${AUTH_DB_PASSWORD}';
CREATE USER anno_core WITH PASSWORD '${CORE_DB_PASSWORD}';
CREATE USER anno_config WITH PASSWORD '${CONFIG_DB_PASSWORD}';
CREATE USER anno_monitoring WITH PASSWORD '${MONITORING_DB_PASSWORD}';
CREATE USER anno_security WITH PASSWORD '${SECURITY_DB_PASSWORD}';

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE anno_auth TO anno_auth;
GRANT ALL PRIVILEGES ON DATABASE anno_core TO anno_core;
GRANT ALL PRIVILEGES ON DATABASE anno_config TO anno_config;
GRANT ALL PRIVILEGES ON DATABASE anno_monitoring TO anno_monitoring;
GRANT ALL PRIVILEGES ON DATABASE anno_security TO anno_security;
EOF
    
    log_success "Database initialization scripts created"
}

# Create monitoring configuration
setup_monitoring() {
    log_info "Setting up monitoring configuration..."
    
    local monitoring_dir="$PLATFORM_DIR/monitoring"
    mkdir -p "$monitoring_dir/grafana/dashboards" "$monitoring_dir/grafana/datasources"
    
    # Prometheus configuration
    cat > "$monitoring_dir/prometheus.yml" << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "rules/*.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'anno-core'
    static_configs:
      - targets: ['anno-core-1:5213', 'anno-core-2:5213', 'anno-core-3:5213']
    metrics_path: '/metrics'
    scrape_interval: 30s

  - job_name: 'anno-enterprise'
    static_configs:
      - targets: ['anno-enterprise-1:5213', 'anno-enterprise-2:5213']
    metrics_path: '/metrics'
    scrape_interval: 30s

  - job_name: 'auth-service'
    static_configs:
      - targets: ['auth-service:3000']
    metrics_path: '/metrics'
    scrape_interval: 30s

  - job_name: 'config-service'
    static_configs:
      - targets: ['config-service:3001']
    metrics_path: '/metrics'
    scrape_interval: 30s

  - job_name: 'monitoring-service'
    static_configs:
      - targets: ['monitoring-service:9090']
    metrics_path: '/metrics'
    scrape_interval: 30s
EOF

    # Grafana datasource configuration
    cat > "$monitoring_dir/grafana/datasources/prometheus.yml" << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
EOF

    log_success "Monitoring configuration created"
}

# Build and deploy services
deploy_services() {
    log_info "Building and deploying services..."
    
    cd "$PLATFORM_DIR"
    
    # Build images
    log_info "Building Docker images..."
    docker-compose build --parallel
    
    # Start services
    log_info "Starting services..."
    docker-compose up -d
    
    # Wait for services to be healthy
    log_info "Waiting for services to be healthy..."
    wait_for_services
    
    log_success "All services deployed successfully"
}

# Wait for services to be healthy
wait_for_services() {
    local services=(
        "postgres:5432"
        "redis:6379"
        "auth-service:3000"
        "anno-core-1:5213"
        "anno-core-2:5213"
        "anno-core-3:5213"
        "api-gateway:80"
    )
    
    for service in "${services[@]}"; do
        local host_port=(${service//:/ })
        local host=${host_port[0]}
        local port=${host_port[1]}
        
        log_info "Waiting for $service..."
        local retries=0
        local max_retries=30
        
        while [ $retries -lt $max_retries ]; do
            if docker-compose exec -T "$host" curl -f "http://localhost:$port/health" >/dev/null 2>&1; then
                log_success "$service is healthy"
                break
            fi
            
            retries=$((retries + 1))
            sleep 2
        done
        
        if [ $retries -eq $max_retries ]; then
            log_error "Failed to start $service after $max_retries retries"
            exit 1
        fi
    done
}

# Create initial tenant
create_initial_tenant() {
    log_info "Creating initial tenant..."
    
    # Wait for auth service to be ready
    sleep 10
    
    # Create initial tenant via API
    local response=$(curl -s -X POST "http://localhost/api/v1/tenants" \
        -H "Content-Type: application/json" \
        -H "X-Admin-Key: ${ADMIN_API_KEY:-admin-key-123}" \
        -d '{
            "companyName": "Demo Company",
            "companyDomain": "demo.example.com",
            "contactEmail": "admin@demo.example.com",
            "region": "us"
        }' || echo "failed")
    
    if [ "$response" != "failed" ]; then
        log_success "Initial tenant created successfully"
    else
        log_warning "Failed to create initial tenant. You can create one manually via the API."
    fi
}

# Display deployment information
show_deployment_info() {
    log_success "Deployment completed successfully!"
    echo
    echo "=============================================="
    echo "Anno Enterprise Platform Deployment Complete"
    echo "=============================================="
    echo
    echo "🌐 API Gateway:      https://$DOMAIN"
    echo "📊 Grafana:          http://localhost:3001 (admin / $GRAFANA_PASSWORD)"
    echo "📈 Prometheus:       http://localhost:9091"
    echo "🔍 Kibana:           http://localhost:5601"
    echo "🔬 Jaeger:           http://localhost:16686"
    echo
    echo "📁 Logs Directory:   $PLATFORM_DIR/logs"
    echo "🔧 Environment:      $PLATFORM_DIR/.env"
    echo "🐳 Docker Compose:   $PLATFORM_DIR/docker-compose.yml"
    echo
    echo "📋 Useful Commands:"
    echo "  View logs:         docker-compose logs -f [service-name]"
    echo "  Scale services:    docker-compose up -d --scale anno-core-1=3"
    echo "  Stop platform:     docker-compose down"
    echo "  Restart service:   docker-compose restart [service-name]"
    echo
    echo "🔐 Security Notes:"
    echo "  - Change default passwords in .env file"
    echo "  - Configure proper SSL certificates for production"
    echo "  - Set up firewall rules and network security"
    echo "  - Enable backup and disaster recovery"
    echo
}

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    docker-compose down -v
    log_success "Cleanup completed"
}

# Main deployment function
main() {
    log_info "Starting Anno Enterprise Platform deployment..."
    log_info "Environment: $ENVIRONMENT"
    log_info "Domain: $DOMAIN"
    log_info "Region: $REGION"
    echo
    
    # Parse command line arguments
    case "${1:-deploy}" in
        "deploy")
            check_prerequisites
            generate_env_file
            generate_ssl_certificates
            initialize_database
            setup_monitoring
            deploy_services
            create_initial_tenant
            show_deployment_info
            ;;
        "cleanup")
            cleanup
            ;;
        "logs")
            docker-compose logs -f "${2:-}"
            ;;
        "status")
            docker-compose ps
            ;;
        "restart")
            docker-compose restart "${2:-}"
            ;;
        "scale")
            if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
                log_error "Usage: $0 scale <service> <count>"
                exit 1
            fi
            docker-compose up -d --scale "$2=$3"
            ;;
        "help")
            echo "Usage: $0 [command] [options]"
            echo
            echo "Commands:"
            echo "  deploy     Deploy the entire platform (default)"
            echo "  cleanup    Stop and remove all containers and volumes"
            echo "  logs       Show logs for services"
            echo "  status     Show status of all services"
            echo "  restart    Restart a specific service"
            echo "  scale      Scale a service to N replicas"
            echo "  help       Show this help message"
            echo
            echo "Examples:"
            echo "  $0 deploy"
            echo "  $0 logs auth-service"
            echo "  $0 scale anno-core-1 5"
            echo "  $0 restart api-gateway"
            ;;
        *)
            log_error "Unknown command: $1"
            log_error "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
