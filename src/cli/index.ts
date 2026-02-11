#!/usr/bin/env node
/**
 * Anno CLI - command-line interface for Anno web content extractor.
 */

import { Command } from 'commander';
import { startCommand } from './commands/start';
import { healthCommand } from './commands/health';
import { fetchCommand } from './commands/fetch';
import { crawlCommand } from './commands/crawl';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json');

const program = new Command();

program
  .name('anno')
  .description('Anno - AI-native web content extractor')
  .version(pkg.version);

program.addCommand(startCommand);
program.addCommand(healthCommand);
program.addCommand(fetchCommand);
program.addCommand(crawlCommand);

program.parse();
