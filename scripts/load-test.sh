#!/bin/bash
#
# Basic Load Test for Anno MVP
#
# Tests the system under load to ensure it doesn't break
# Uses simple curl commands with parallel execution
#

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:5213}"
CONCURRENT="${CONCURRENT:-10}"
REQUESTS="${REQUESTS:-100}"
VERBOSE="${VERBOSE:-0}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "====================================="
echo "Anno MVP Load Test"
echo "====================================="
echo "Base URL: $BASE_URL"
echo "Concurrent: $CONCURRENT"
echo "Total Requests: $REQUESTS"
echo "====================================="
echo ""

# Test health endpoint
test_health() {
    local success=0
    local failures=0
    local total=$1

    echo "Testing /health endpoint..."

    for i in $(seq 1 $total); do
        if [ "$VERBOSE" -eq 1 ]; then
            echo -n "Request $i/$total... "
        fi

        response=$(curl -s -w "%{http_code}" -o /dev/null "$BASE_URL/health")

        if [ "$response" -eq 200 ]; then
            ((success++))
            [ "$VERBOSE" -eq 1 ] && echo -e "${GREEN}OK${NC}"
        else
            ((failures++))
            [ "$VERBOSE" -eq 1 ] && echo -e "${RED}FAILED (HTTP $response)${NC}"
        fi
    done

    echo -e "${GREEN}✓${NC} Health: $success/$total succeeded ($failures failures)"
    return $failures
}

# Test metrics endpoint
test_metrics() {
    local success=0
    local failures=0
    local total=$1

    echo "Testing /metrics endpoint..."

    for i in $(seq 1 $total); do
        response=$(curl -s -w "%{http_code}" -o /dev/null "$BASE_URL/metrics")

        if [ "$response" -eq 200 ]; then
            ((success++))
        else
            ((failures++))
        fi
    done

    echo -e "${GREEN}✓${NC} Metrics: $success/$total succeeded ($failures failures)"
    return $failures
}

# Parallel test runner
run_parallel() {
    local endpoint=$1
    local data=$2
    local total_requests=$3
    local concurrent=$4

    local success=0
    local failures=0
    local pids=()

    # Temporary file for results
    local tmpfile=$(mktemp)

    for i in $(seq 1 $total_requests); do
        # Wait if we've hit max concurrent
        while [ ${#pids[@]} -ge $concurrent ]; do
            for pid in "${pids[@]}"; do
                if ! kill -0 $pid 2>/dev/null; then
                    # Process finished, remove from array
                    pids=("${pids[@]/$pid}")
                fi
            done
            sleep 0.01
        done

        # Start new request
        (
            response=$(curl -s -w "%{http_code}" -o /dev/null \
                -X POST "$BASE_URL$endpoint" \
                -H "Content-Type: application/json" \
                -d "$data")
            echo "$response" >> "$tmpfile"
        ) &
        pids+=($!)
    done

    # Wait for all remaining processes
    for pid in "${pids[@]}"; do
        wait $pid 2>/dev/null || true
    done

    # Count results
    while read -r code; do
        if [ "$code" -eq 200 ] || [ "$code" -eq 202 ]; then
            ((success++))
        else
            ((failures++))
        fi
    done < "$tmpfile"

    rm -f "$tmpfile"

    echo "$success $failures"
}

# Test semantic search endpoint
test_semantic_search() {
    local total=$1
    local concurrent=$2

    echo "Testing /v1/semantic/search endpoint (parallel: $concurrent)..."

    local data='{
        "query": "test query",
        "k": 5
    }'

    local results=$(run_parallel "/v1/semantic/search" "$data" "$total" "$concurrent")
    local success=$(echo $results | cut -d' ' -f1)
    local failures=$(echo $results | cut -d' ' -f2)

    echo -e "${GREEN}✓${NC} Semantic Search: $success/$total succeeded ($failures failures)"
    return $failures
}

# Main test execution
main() {
    local total_failures=0
    local start_time=$(date +%s)

    # Health check tests (sequential)
    test_health 10
    ((total_failures+=$?))
    echo ""

    # Metrics tests (sequential)
    test_metrics 10
    ((total_failures+=$?))
    echo ""

    # Semantic search tests (parallel)
    test_semantic_search $REQUESTS $CONCURRENT
    ((total_failures+=$?))
    echo ""

    # Summary
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local total_requests=$((20 + REQUESTS))
    local throughput=$(echo "scale=2; $total_requests / $duration" | bc)

    echo "====================================="
    echo "Load Test Summary"
    echo "====================================="
    echo "Total Duration: ${duration}s"
    echo "Total Requests: $total_requests"
    echo "Throughput: ${throughput} req/s"
    echo "Total Failures: $total_failures"

    if [ $total_failures -eq 0 ]; then
        echo -e "${GREEN}✓ All tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}✗ Some tests failed${NC}"
        exit 1
    fi
}

# Check if server is running
if ! curl -s "$BASE_URL/health" > /dev/null; then
    echo -e "${RED}Error: Server not running at $BASE_URL${NC}"
    echo "Start the server first: npm start"
    exit 1
fi

# Run tests
main
