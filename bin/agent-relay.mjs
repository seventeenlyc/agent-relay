#!/usr/bin/env node
// bin/agent-relay.mjs
// 薄 shim：Node 24 可直接运行 .ts，因此这里只负责转发 argv 与退出码。
import { runCli } from '../packages/cli/src/cli.ts';

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
