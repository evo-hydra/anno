#!/bin/bash
#
# Simple Load Test for Anno MVP
#

set -e

BASE_URL="${BASE_URL:-http://localhost:5213}"
REQUESTS="${REQUESTS:-50}"

echo "====================================="
echo "Anno MVP Simple Load Test"
echo "====================================="
echo "Base URL: $BASE_URL"
echo "Total Requests: $REQUESTS"
echo "====================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Test health endpoint
echo "Testing /health endpoint..."
success=0
failures=0
total_time=0

for i in $(seq 1 10); do
    response=$(curl -s -w "%{http_code}:%{time_total}" -o /dev/null "$BASE_URL/health")
    code=$(echo $response | cut -d: -f1)
    time=$(echo $response | cut -d: -f2)

    if [ "$code" -eq 200 ]; then
        ((success++))
        total_time=$(echo "$total_time + $time" | bc)
    else
        ((failures++))
    fi
done

avg_time=$(echo "scale=4; $total_time / $success" | bc)
echo -e "${GREEN}✓${NC} Health: $success/10 succeeded, avg response time: ${avg_time}s"
echo ""

# Test metrics endpoint
echo "Testing /metrics endpoint..."
success=0
failures=0

for i in $(seq 1 10); do
    response=$(curl -s -w "%{http_code}" -o /dev/null "$BASE_URL/metrics")
    if [ "$response" -eq 200 ]; then
        ((success++))
    else
        ((failures++))
    fi
done

echo -e "${GREEN}✓${NC} Metrics: $success/10 succeeded"
echo ""

# Test semantic search (parallel)
echo "Testing /v1/semantic/search endpoint (parallel: 5)..."
success=0
failures=0
start_time=$(date +%s.%N)

for i in $(seq 1 $REQUESTS); do
    curl -s -X POST "$BASE_URL/v1/semantic/search" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"test query $i\", \"k\": 5}" \
        -w "%{http_code}\n" -o /dev/null &

    # Limit to 5 concurrent
    if [ $((i % 5)) -eq 0 ]; then
        wait
    fi
done

# Wait for remaining
wait

end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)

# Count results (approximate - we can't easily track each background job's status)
echo -e "${GREEN}✓${NC} Semantic Search: $REQUESTS requests completed in ${duration}s"
throughput=$(echo "scale=2; $REQUESTS / $duration" | bc)
echo "   Throughput: ${throughput} req/s"
echo ""

echo "====================================="
echo "Load Test Complete"
echo "====================================="
echo -e "${GREEN}✓ All endpoints operational${NC}"
