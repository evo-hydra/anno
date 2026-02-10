import { Command } from 'commander';
import http from 'http';

export const crawlCommand = new Command('crawl')
  .description('Crawl a website starting from a URL')
  .argument('<url>', 'Starting URL to crawl')
  .option('-p, --port <port>', 'Server port', '5213')
  .option('-d, --depth <depth>', 'Maximum crawl depth', '2')
  .option('-m, --max-pages <pages>', 'Maximum pages to crawl', '10')
  .option('--json', 'Output raw JSON response')
  .action((url: string, options) => {
    const body = JSON.stringify({
      url,
      maxDepth: parseInt(options.depth, 10),
      maxPages: parseInt(options.maxPages, 10),
    });

    const req = http.request({
      hostname: 'localhost',
      port: parseInt(options.port, 10),
      path: '/v1/crawl',
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
            if (result.jobId) {
              console.log(`Crawl job started: ${result.jobId}`);
              console.log(`Status: ${result.status || 'queued'}`);
            } else if (result.pages) {
              console.log(`Crawled ${result.pages.length} pages:`);
              for (const page of result.pages) {
                console.log(`  ${page.url} (${page.status || 'ok'})`);
              }
            } else {
              console.log(JSON.stringify(result, null, 2));
            }
          }
        } catch {
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
