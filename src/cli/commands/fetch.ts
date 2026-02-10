import { Command } from 'commander';
import http from 'http';

export const fetchCommand = new Command('fetch')
  .description('Fetch and extract content from a URL')
  .argument('<url>', 'URL to fetch')
  .option('-p, --port <port>', 'Server port', '5213')
  .option('--json', 'Output raw JSON response')
  .option('--render', 'Enable browser rendering for this request')
  .action((url: string, options) => {
    const body = JSON.stringify({
      url,
      render: options.render || false,
    });

    const req = http.request({
      hostname: 'localhost',
      port: parseInt(options.port, 10),
      path: '/v1/content/fetch',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            if (result.content) {
              console.log(result.content);
            } else if (result.error) {
              console.error(`Error: ${result.error}`);
              process.exit(1);
            } else {
              console.log(JSON.stringify(result, null, 2));
            }
          }
        } catch {
          // Not JSON — print raw
          console.log(data);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`Cannot connect to Anno on port ${options.port}: ${err.message}`);
      process.exit(1);
    });

    req.write(body);
    req.end();
  });
