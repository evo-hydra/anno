import { Command } from 'commander';

export const startCommand = new Command('start')
  .description('Start the Anno server')
  .option('-p, --port <port>', 'Port to listen on', '5213')
  .option('--no-render', 'Disable browser rendering')
  .action(async (options) => {
    process.env.PORT = options.port;
    if (options.render === false) {
      process.env.RENDERING_ENABLED = 'false';
    }
    console.log(`Starting Anno on port ${options.port}...`);
    // Dynamic import to avoid loading server code for other commands
    await import('../../server');
  });
