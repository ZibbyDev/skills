#!/usr/bin/env node
/**
 * A stand-in for the `gbrain` CLI, so the adapter's process handling can be
 * tested without Bun, PGLite or an embedding provider. It speaks just enough of
 * the real contract (`init`, `embed`, `--version`, and `serve` as an MCP stdio
 * server) and appends one line per event to $FAKE_GBRAIN_LOG:
 *
 *   serve-start <pid> key=yes|no      a `gbrain serve` process came up
 *   tool <pid> <name> [k=v …]         a tools/call it received
 *   done <pid> <name>                 …and answered (after FAKE_<NAME>_DELAY_MS)
 *   cli <args…>                       a one-shot CLI invocation
 *
 * Whether a process "has a key" is read from its own environment — exactly the
 * fact that decides, in the real gbrain, whether put_page embeds inline.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const log = (line) => appendFileSync(process.env.FAKE_GBRAIN_LOG, `${line}\n`);
const args = process.argv.slice(2);
const hasKey = (process.env.OPENAI_API_KEY || '').length > 0 ? 'yes' : 'no';

if (args[0] !== 'serve') {
  log(`cli ${args.join(' ')} key=${hasKey}`);
  if (args[0] === 'init') {
    const dir = join(process.env.GBRAIN_HOME, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
  }
  if (args[0] === '--version') process.stdout.write('gbrain fake\n');
  process.exit(0);
}

log(`serve-start ${process.pid} key=${hasKey}`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const text = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) });

let inflight = 0;
const delayed = (name, id, result) => {
  const ms = Number(process.env[`FAKE_${name.toUpperCase()}_DELAY_MS`]) || 0;
  inflight += 1;
  setTimeout(() => { inflight -= 1; log(`done ${process.pid} ${name}`); reply(id, result); }, ms);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method !== 'tools/call') return undefined;
  const { name, arguments: a = {} } = msg.params;
  if (name === 'query') {
    log(`tool ${process.pid} query expand=${a.expand} key=${hasKey} inflight=${inflight + 1}`);
    return delayed('query', msg.id, text([{ slug: 'doc/x', chunk_text: 'a remembered decision', score: 0.9 }]));
  }
  if (name === 'put_page') {
    log(`tool ${process.pid} put_page key=${hasKey}`);
    return delayed('put_page', msg.id, text({ slug: a.slug, chunks: 1 }));
  }
  if (name === 'restore_page') return reply(msg.id, text('page is live', true));
  if (name === 'purge_deleted_pages') { log(`tool ${process.pid} purge_deleted_pages`); return reply(msg.id, text({ count: 0 })); }
  if (name === 'delete_page') return reply(msg.id, text({ status: 'soft_deleted' }));
  return reply(msg.id, text(`unknown tool ${name}`, true));
}).on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
