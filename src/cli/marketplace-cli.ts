#!/usr/bin/env node
/**
 * Marketplace Adapter CLI - Operations Tool
 *
 * Command-line interface for managing, monitoring, and debugging
 * the marketplace adapter system.
 *
 * @module cli/marketplace-cli
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { telemetryManager, type TelemetryEventType } from '../services/extractors/extraction-telemetry';
import type { MarketplaceType } from '../services/extractors/marketplace-adapter';
import { MarketplaceDemoRunner } from '../services/extractors/demo-script';
import { marketplaceRegistry } from '../services/extractors/marketplace-registry';
import { featureFlags } from '../services/extractors/feature-flags';

const program = new Command();

program
  .name('marketplace-cli')
  .description('Marketplace Adapter System - Operations CLI')
  .version('2.0.0');

// ============================================================================
// Demo Command
// ============================================================================

program
  .command('demo')
  .description('Run production demo')
  .option('-m, --marketplaces <names>', 'Marketplaces to demo (comma-separated)', 'ebay,amazon,walmart')
  .option('--no-fixtures', 'Use live scraping instead of fixtures')
  .option('--no-report', 'Skip generating detailed report')
  .option('--exit-on-error', 'Exit on first error')
  .action(async (options) => {
    console.log(chalk.blue('\n🚀 Starting Production Demo\n'));

    const marketplaces = options.marketplaces.split(',').map((m: string) => m.trim());

    const demo = new MarketplaceDemoRunner({
      useFixtures: options.fixtures !== false,
      marketplaces,
      outputReport: options.report !== false,
      exitOnError: options.exitOnError || false,
    });

    try {
      const result = await demo.run();
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('\n❌ Demo failed:'), error);
      process.exit(1);
    }
  });

// ============================================================================
// Health Command
// ============================================================================

program
  .command('health')
  .description('Check system health')
  .option('-v, --verbose', 'Show detailed health report')
  .action((options) => {
    console.log(chalk.blue('\n🏥 System Health Check\n'));

    const health = telemetryManager.getHealthReport();
    const metrics = health.metrics;

    const statusColor = {
      healthy: chalk.green,
      degraded: chalk.yellow,
      unhealthy: chalk.red,
    }[health.status];

    console.log(`Status: ${statusColor(health.status.toUpperCase())}\n`);

    console.log(chalk.bold('Metrics:'));
    console.log(`  Extractions: ${metrics.successfulExtractions}/${metrics.totalExtractions}`);
    console.log(`  Success Rate: ${chalk.cyan((metrics.successRate * 100).toFixed(1))}%`);
    console.log(`  Avg Confidence: ${chalk.cyan(metrics.averageConfidence.toFixed(2))}`);
    console.log(`  Avg Duration: ${chalk.cyan(metrics.avgDuration.toFixed(0))}ms`);
    console.log(`  Cache Hit Rate: ${chalk.cyan((metrics.cacheHitRate * 100).toFixed(1))}%`);
    console.log(`  Rate Limit Hits: ${metrics.rateLimitHits}`);
    console.log(`  Fallbacks Used: ${metrics.fallbacksUsed}`);

    if (health.issues.length > 0) {
      console.log(chalk.yellow('\n⚠️  Issues:'));
      health.issues.forEach(issue => console.log(`  - ${issue}`));
    }

    if (health.recommendations.length > 0) {
      console.log(chalk.blue('\n💡 Recommendations:'));
      health.recommendations.forEach(rec => console.log(`  - ${rec}`));
    }

    if (options.verbose) {
      console.log(chalk.gray('\n📊 Detailed Metrics:'));
      console.log(JSON.stringify(metrics, null, 2));
    }

    console.log('');

    process.exit(health.status === 'unhealthy' ? 1 : 0);
  });

// ============================================================================
// Telemetry Command
// ============================================================================

program
  .command('telemetry')
  .description('View telemetry data')
  .option('-n, --limit <number>', 'Number of recent events to show', '10')
  .option('-t, --type <type>', 'Filter by event type')
  .option('-m, --marketplace <name>', 'Filter by marketplace')
  .option('--export <path>', 'Export full report to file')
  .action(async (options) => {
    console.log(chalk.blue('\n📊 Telemetry Data\n'));

    const limit = parseInt(options.limit, 10);

    // Apply filters
    const filter: { eventType?: TelemetryEventType; marketplace?: MarketplaceType } = {};
    if (options.type) filter.eventType = options.type;
    if (options.marketplace) filter.marketplace = options.marketplace;

    const events = Object.keys(filter).length > 0
      ? telemetryManager.queryEvents(filter).slice(-limit)
      : telemetryManager.getRecentEvents(limit);

    if (events.length === 0) {
      console.log(chalk.yellow('No events found'));
      return;
    }

    console.log(chalk.bold(`Showing ${events.length} events:\n`));

    events.forEach((event, i) => {
      const typeColor: Record<string, typeof chalk.blue> = {
        extraction_started: chalk.blue,
        extraction_completed: chalk.green,
        extraction_failed: chalk.red,
        validation_completed: chalk.cyan,
        rate_limit_hit: chalk.yellow,
        retry_attempted: chalk.magenta,
        fallback_selector_used: chalk.yellow,
        cache_hit: chalk.green,
        cache_miss: chalk.gray,
      };
      const color = typeColor[event.eventType] || chalk.gray;

      console.log(`${i + 1}. ${color(event.eventType)}`);
      console.log(`   ${chalk.gray(event.timestamp)}`);
      console.log(`   ${event.marketplace}: ${event.url}`);

      if (event.duration) {
        console.log(`   Duration: ${event.duration}ms`);
      }

      if (event.confidence) {
        console.log(`   Confidence: ${event.confidence.toFixed(2)}`);
      }

      if (event.error) {
        console.log(chalk.red(`   Error: ${event.error.message}`));
      }

      console.log('');
    });

    // Export if requested
    if (options.export) {
      await telemetryManager.exportReport(options.export);
      console.log(chalk.green(`\n✓ Report exported to ${options.export}`));
    }
  });

// ============================================================================
// Registry Command
// ============================================================================

program
  .command('registry')
  .description('Manage marketplace registry')
  .option('-l, --list', 'List registered marketplaces')
  .option('-m, --metrics <marketplace>', 'Show metrics for marketplace')
  .option('-c, --config <marketplace>', 'Show config for marketplace')
  .action((options) => {
    console.log(chalk.blue('\n📦 Marketplace Registry\n'));

    if (options.list) {
      const marketplaces = marketplaceRegistry.getRegisteredMarketplaces();
      console.log(chalk.bold('Registered Marketplaces:\n'));

      marketplaces.forEach(mp => {
        const enabled = marketplaceRegistry.isEnabled(mp);
        const status = enabled ? chalk.green('✓ enabled') : chalk.red('✗ disabled');
        console.log(`  ${mp}: ${status}`);
      });

      console.log('');
    }

    if (options.metrics) {
      const metrics = marketplaceRegistry.getMetrics(options.metrics);

      if (!metrics) {
        console.log(chalk.red(`No metrics found for ${options.metrics}`));
        return;
      }

      console.log(chalk.bold(`Metrics for ${options.metrics}:\n`));
      console.log(`  Total Extractions: ${metrics.totalExtractions}`);
      console.log(`  Successful: ${chalk.green(metrics.successfulExtractions)}`);
      console.log(`  Failed: ${chalk.red(metrics.failedExtractions)}`);
      console.log(`  Avg Confidence: ${chalk.cyan(metrics.averageConfidence.toFixed(2))}`);
      console.log(`  Avg Duration: ${chalk.cyan(metrics.averageDuration.toFixed(0))}ms`);
      console.log(`  Rate Limit Hits: ${metrics.rateLimitHits}`);
      console.log(`  Cache Hit Rate: ${chalk.cyan((metrics.cacheHitRate * 100).toFixed(1))}%`);
      console.log('');
    }

    if (options.config) {
      const config = marketplaceRegistry.getConfig(options.config);

      if (!config) {
        console.log(chalk.red(`No config found for ${options.config}`));
        return;
      }

      console.log(chalk.bold(`Config for ${options.config}:\n`));
      console.log(JSON.stringify(config, null, 2));
      console.log('');
    }
  });

// ============================================================================
// Feature Flags Command
// ============================================================================

program
  .command('flags')
  .description('Manage feature flags')
  .option('-l, --list', 'List all flags')
  .option('-e, --enable <flag>', 'Enable a flag')
  .option('-d, --disable <flag>', 'Disable a flag')
  .option('-r, --rollout <flag> <percentage>', 'Set rollout percentage')
  .action((options) => {
    console.log(chalk.blue('\n🚩 Feature Flags\n'));

    if (options.list) {
      const flags = featureFlags.getAllFlags();
      console.log(chalk.bold('All Feature Flags:\n'));

      Object.entries(flags).forEach(([name, flag]) => {
        const status = flag.enabled ? chalk.green('✓ enabled') : chalk.red('✗ disabled');
        const rollout = flag.rolloutPercentage !== undefined
          ? ` (${flag.rolloutPercentage}% rollout)`
          : '';
        console.log(`  ${name}: ${status}${rollout}`);
        if (flag.description) {
          console.log(`    ${chalk.gray(flag.description)}`);
        }
      });

      console.log('');
    }

    if (options.enable) {
      featureFlags.enable(options.enable);
      console.log(chalk.green(`✓ Enabled ${options.enable}`));
    }

    if (options.disable) {
      featureFlags.disable(options.disable);
      console.log(chalk.yellow(`✓ Disabled ${options.disable}`));
    }

    if (options.rollout) {
      const [flag, percentage] = options.rollout;
      featureFlags.setRolloutPercentage(flag, parseInt(percentage, 10));
      console.log(chalk.green(`✓ Set ${flag} rollout to ${percentage}%`));
    }
  });

// ============================================================================
// Extract Command (Single URL)
// ============================================================================

program
  .command('extract <url>')
  .description('Extract a single URL')
  .option('-v, --verbose', 'Show detailed extraction info')
  .action(async (url, options) => {
    console.log(chalk.blue('\n🔍 Extracting URL\n'));
    console.log(`URL: ${url}\n`);

    try {
      const result = await marketplaceRegistry.extractListing(url);

      if (result.success && result.listing) {
        console.log(chalk.green('✓ Extraction successful\n'));
        console.log(chalk.bold('Listing:'));
        console.log(`  Title: ${result.listing.title}`);
        console.log(`  Price: ${result.listing.price?.amount} ${result.listing.price?.currency}`);
        console.log(`  Condition: ${result.listing.condition || 'N/A'}`);
        console.log(`  Availability: ${result.listing.availability}`);
        console.log(`  Confidence: ${chalk.cyan(result.listing.confidence.toFixed(2))}`);
        console.log(`  Marketplace: ${result.listing.marketplace}`);

        if (options.verbose) {
          console.log(chalk.gray('\nFull Listing:'));
          console.log(JSON.stringify(result.listing, null, 2));

          console.log(chalk.gray('\nMetadata:'));
          console.log(`  Duration: ${result.metadata.duration}ms`);
          console.log(`  Retry Count: ${result.metadata.retryCount}`);
          console.log(`  Rate Limited: ${result.metadata.rateLimited}`);
          console.log(`  Cached: ${result.metadata.cached}`);
        }
      } else {
        console.log(chalk.red('✗ Extraction failed\n'));
        if (result.error) {
          console.log(`Error: ${result.error.message}`);
          console.log(`Code: ${result.error.code}`);
          console.log(`Recoverable: ${result.error.recoverable}`);
        }
      }

      console.log('');
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('\n❌ Extraction error:'), error);
      process.exit(1);
    }
  });

// ============================================================================
// Reset Command
// ============================================================================

program
  .command('reset')
  .description('Reset telemetry data')
  .option('--confirm', 'Confirm reset')
  .action((options) => {
    if (!options.confirm) {
      console.log(chalk.yellow('\n⚠️  This will reset all telemetry data!'));
      console.log('Use --confirm to proceed');
      process.exit(1);
    }

    telemetryManager.reset();
    console.log(chalk.green('\n✓ Telemetry data reset\n'));
  });

// ============================================================================
// Parse and Execute
// ============================================================================

program.parse();
