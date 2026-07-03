import { describe, it, expect, afterEach, vi } from 'vitest';

// Stub the backend-client so no real cloud call happens; individual tests
// override the mock's behavior per-case.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({ token: 'cloud-token', guildId: 'G_CLOUD' })),
}));

const { resolveIntegrationToken } = await import('@zibby/core/backend-client.js');
const { discordSkill, chunkDiscordContent, DISCORD_MAX_CONTENT } = await import('../src/discord.js');

const ENV = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_API_URL'];
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mockFetchOnce(sequence) {
  // sequence: array of { status, json } consumed in order.
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    const next = sequence.shift() || { status: 200, json: {} };
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.json,
    };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

describe('discordSkill shape', () => {
  it('registers under id discord with the two tools', () => {
    expect(discordSkill.id).toBe('discord');
    expect(discordSkill.requiresIntegration).toBe('discord');
    expect(discordSkill.tools.map((t) => t.name)).toEqual([
      'discord_send_message',
      'discord_list_channels',
    ]);
  });

  it('resolve() spawns the generic mcp-skill binary pointed at discordSkill', () => {
    const spec = discordSkill.resolve();
    // In the repo layout bin/mcp-skill.mjs exists → full spawn spec.
    expect(spec.args?.slice(-2)).toEqual(['../dist/discord.js', 'discordSkill']);
  });
});

describe('chunkDiscordContent', () => {
  it('short text → single chunk, empty text → []', () => {
    expect(chunkDiscordContent('hi')).toEqual(['hi']);
    expect(chunkDiscordContent('')).toEqual([]);
    expect(chunkDiscordContent('   ')).toEqual([]);
  });
  it('splits >2000 chars into <=2000-char chunks preserving all content', () => {
    const line = 'x'.repeat(120);
    const text = Array.from({ length: 30 }, () => line).join('\n'); // ~3630 chars
    const chunks = chunkDiscordContent(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT);
    expect(chunks.join('')).toBe(text);
  });
  it('hard-slices a single overlong line', () => {
    const text = 'y'.repeat(4500);
    const chunks = chunkDiscordContent(text);
    expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);
  });
});

describe('discord_send_message', () => {
  it('fail-soft: missing args → {ok:false}', async () => {
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', {}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/required/);
  });

  it('env DISCORD_BOT_TOKEN wins (self-host) and posts with Bot prefix', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    const { calls } = mockFetchOnce([{ status: 200, json: { id: 'm1' } }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', { channelId: 'C1', text: 'hello' }));
    expect(res).toMatchObject({ ok: true, channelId: 'C1', messageIds: ['m1'], chunks: 1 });
    expect(resolveIntegrationToken).not.toHaveBeenCalled();
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/C1/messages');
    expect(calls[0].opts.headers.Authorization).toBe('Bot env-token');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ content: 'hello' });
  });

  it('no env token → cloud resolveIntegrationToken path', async () => {
    const { calls } = mockFetchOnce([{ status: 200, json: { id: 'm2' } }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', { channelId: 'C2', text: 'from cloud' }));
    expect(res.ok).toBe(true);
    expect(resolveIntegrationToken).toHaveBeenCalledWith('discord');
    expect(calls[0].opts.headers.Authorization).toBe('Bot cloud-token');
  });

  it('fail-soft: not connected anywhere → {ok:false, error}', async () => {
    resolveIntegrationToken.mockRejectedValueOnce(new Error('discord is not connected. Connect it at https://studio.zibby.dev/integrations'));
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', { channelId: 'C3', text: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
  });

  it('fail-soft: Discord API error surfaces as {ok:false}', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    mockFetchOnce([{ status: 403, json: { message: 'Missing Access' } }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', { channelId: 'C4', text: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/403.*Missing Access/);
  });

  it('chunks long text into multiple POSTs', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    const { calls } = mockFetchOnce([
      { status: 200, json: { id: 'a' } },
      { status: 200, json: { id: 'b' } },
      { status: 200, json: { id: 'c' } },
    ]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_send_message', { channelId: 'C5', text: 'z'.repeat(4500) }));
    expect(res).toMatchObject({ ok: true, messageIds: ['a', 'b', 'c'], chunks: 3 });
    expect(calls.length).toBe(3);
  });
});

describe('discord_list_channels', () => {
  const guildChannels = [
    { id: 'ch1', name: 'general', type: 0, topic: 'talk' },
    { id: 'ch2', name: 'voice', type: 2 },
    { id: 'ch3', name: 'news', type: 5 },
  ];

  it('explicit guildId → lists text + announcement channels only', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    const { calls } = mockFetchOnce([{ status: 200, json: guildChannels }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_list_channels', { guildId: 'G1' }));
    expect(res.ok).toBe(true);
    expect(res.guildId).toBe('G1');
    expect(res.channels).toEqual([
      { id: 'ch1', name: 'general', type: 'text', topic: 'talk' },
      { id: 'ch3', name: 'news', type: 'announcement' },
    ]);
    expect(calls[0].url).toBe('https://discord.com/api/v10/guilds/G1/channels');
  });

  it('no guildId, cloud integration captured one → uses it', async () => {
    const { calls } = mockFetchOnce([{ status: 200, json: guildChannels }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_list_channels', {}));
    expect(res.ok).toBe(true);
    expect(res.guildId).toBe('G_CLOUD');
    expect(calls[0].url).toContain('/guilds/G_CLOUD/channels');
  });

  it('no guildId anywhere, bot in exactly one guild → auto-resolves', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    const { calls } = mockFetchOnce([
      { status: 200, json: [{ id: 'GONLY', name: 'Only' }] }, // /users/@me/guilds
      { status: 200, json: guildChannels },
    ]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_list_channels', {}));
    expect(res.ok).toBe(true);
    expect(res.guildId).toBe('GONLY');
    expect(calls[0].url).toContain('/users/@me/guilds');
  });

  it('fail-soft: bot in multiple guilds with no hint → {ok:false} listing them', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-token';
    mockFetchOnce([{ status: 200, json: [{ id: 'G1', name: 'A' }, { id: 'G2', name: 'B' }] }]);
    const res = JSON.parse(await discordSkill.handleToolCall('discord_list_channels', {}));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pass guildId/i);
  });
});

describe('unknown tool', () => {
  it('returns {ok:false}', async () => {
    const res = JSON.parse(await discordSkill.handleToolCall('discord_nope', {}));
    expect(res.ok).toBe(false);
  });
});
