import { Command } from 'commander';
import http from 'http';

export const healthCommand = new Command('health')
  .description('Check Anno server health')
  .option('-p, --port <port>', 'Server port', '5213')
  .option('--json', 'Output raw JSON')
  .action((options) => {
    const url = `http://localhost:${options.port}/health`;

    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const health = JSON.parse(data);
          if (options.json) {
            console.log(JSON.stringify(health, null, 2));
          } else {
            const status = health.status === 'healthy' ? 'HEALTHY' : health.status?.toUpperCase() || 'UNKNOWN';
            console.log(`Status: ${status}`);
            console.log(`Uptime: ${health.uptime || 'N/A'}`);
            if (health.version) console.log(`Version: ${health.version}`);
            if (health.cache) console.log(`Cache: ${JSON.stringify(health.cache)}`);
          }
          process.exit(health.status === 'healthy' ? 0 : 1);
        } catch {
          console.error('Failed to parse health response');
          process.exit(1);
        }
      });
    }).on('error', (err) => {
      console.error(`Cannot connect to Anno on port ${options.port}: ${err.message}`);
      process.exit(1);
    });
  });
