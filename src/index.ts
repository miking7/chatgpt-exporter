#!/usr/bin/env node

import { createCli } from './cli/index.js';

// Commands set process.exitCode and handle Ctrl+C themselves (backup stops after the current step).
await createCli().parseAsync(process.argv);
