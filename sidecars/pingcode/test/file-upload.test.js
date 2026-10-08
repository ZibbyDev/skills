// A PingCode `File` parameter must go out as a real multipart upload, not JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForm, registerTools } from '../src/tools.js';
import { PingCodeOAuth } from '../src/pingcode.js';

test('buildForm: file becomes a multipart part with its name and type, fields stay strings', async () => {
  const bytes = Buffer.from('hello png');
  const form = buildForm({ title: 'shot', principal_id: 'x1' }, {
    file: { filename: 'a.png', content_base64: bytes.toString('base64'), content_type: 'image/png' },
  });
  assert.equal(form.get('title'), 'shot');
  const f = form.get('file');
  assert.equal(f.name, 'a.png');
  assert.equal(f.type, 'image/png');
  assert.equal(Buffer.from(await f.arrayBuffer()).toString(), 'hello png');
});

test('buildForm: empty/invalid base64 is refused, not sent', () => {
  assert.throws(() => buildForm({}, { file: { filename: 'a', content_base64: '' } }), /empty or not valid/);
});

test('create_attachments reaches PingCode as a real multipart upload (local server, real fetch)', async () => {
  const http = await import('node:http');
  let seen;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, ct: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') };
      res.setHeader('content-type', 'application/json');
      res.end('{"id":"att1"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const tools = {};
  const server = { registerTool: (name, def, fn) => { tools[name] = { def, fn }; } };
  const orig = PingCodeOAuth.prototype.getValidAccessToken;
  PingCodeOAuth.prototype.getValidAccessToken = async () => 'at';
  process.env.PINGCODE_REST_ROOT = `http://127.0.0.1:${srv.address().port}`;
  try {
    registerTools(server, { mcpToken: 'mcp_x', publicBaseUrl: 'http://x' });
    const t = tools.create_attachments;
    assert.ok(t, 'create_attachments registered');
    assert.ok(!('content-type' in t.def.inputSchema), 'header pseudo-param hidden');
    const r = await t.fn({
      principal_type: 'ticket', principal_id: 'p1', title: 'shot',
      file: { filename: 'a.png', content_base64: Buffer.from('PNGBYTES').toString('base64'), content_type: 'image/png' },
    });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.match(seen.url, /^\/v1\/attachments\?.*principal_id=p1/);
    assert.match(seen.ct, /^multipart\/form-data; boundary=/);
    assert.match(seen.body, /name="file"; filename="a.png"/);
    assert.match(seen.body, /Content-Type: image\/png/);
    assert.match(seen.body, /PNGBYTES/);
    assert.match(seen.body, /name="title"\r\n\r\nshot/);
  } finally {
    PingCodeOAuth.prototype.getValidAccessToken = orig;
    srv.close();
  }
});
