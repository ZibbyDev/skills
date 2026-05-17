import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the backend-client BEFORE importing the skill so resolveIntegrationToken
// is replaced at load time.
vi.mock('@zibby/core/backend-client.js', () => ({
  resolveIntegrationToken: vi.fn(async () => ({
    appId: 'cli_test',
    appSecret: 'sec_test',
    host: 'https://open.larksuite.com',
  })),
}));

const { larkSkill, _resetLarkTokenCache } = await import('../src/lark.js');

function mockFetchOnce(payload) {
  const fetchMock = vi.fn(async () => ({ json: async () => payload }));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

beforeEach(() => {
  _resetLarkTokenCache();
});

describe('larkSkill structure', () => {
  it('has correct id', () => {
    expect(larkSkill.id).toBe('lark');
  });

  it('exposes the expected tools', () => {
    const names = larkSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'lark_get_chat_history',
      'lark_list_chats',
      'lark_reply',
      'lark_send_message',
    ]);
  });

  it('lark_send_message requires receive_id and text', () => {
    const tool = larkSkill.tools.find((t) => t.name === 'lark_send_message');
    expect(tool.input_schema.required).toEqual(['receive_id', 'text']);
  });

  it('lark_reply requires message_id and text', () => {
    const tool = larkSkill.tools.find((t) => t.name === 'lark_reply');
    expect(tool.input_schema.required).toEqual(['message_id', 'text']);
  });
});

describe('lark_send_message', () => {
  it('infers receive_id_type from chat_id prefix and posts message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't-xxx', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'om_123' } }) });
    globalThis.fetch = fetchMock;

    const result = JSON.parse(await larkSkill.handleToolCall('lark_send_message', {
      receive_id: 'oc_abc',
      text: 'hi',
    }));

    expect(result).toEqual({ ok: true, message_id: 'om_123' });
    const sendCall = fetchMock.mock.calls[1];
    expect(sendCall[0]).toContain('receive_id_type=chat_id');
    const body = JSON.parse(sendCall[1].body);
    expect(body.msg_type).toBe('text');
    expect(JSON.parse(body.content)).toEqual({ text: 'hi' });
  });

  it('returns an error when the Lark API rejects', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 99991663, msg: 'app_ticket_invalid' }) });

    const result = JSON.parse(await larkSkill.handleToolCall('lark_send_message', {
      receive_id: 'oc_x',
      text: 'hi',
    }));
    expect(result.error).toMatch(/app_ticket_invalid/);
  });

  it('validates required args', async () => {
    mockFetchOnce({});
    const result = JSON.parse(await larkSkill.handleToolCall('lark_send_message', { receive_id: 'oc_x' }));
    expect(result.error).toMatch(/required/);
  });
});

describe('lark_reply', () => {
  it('posts to the reply endpoint with the message_id encoded in the path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'om_reply' } }) });
    globalThis.fetch = fetchMock;

    const result = JSON.parse(await larkSkill.handleToolCall('lark_reply', {
      message_id: 'om_source',
      text: 'pong',
    }));

    expect(result).toEqual({ ok: true, message_id: 'om_reply' });
    expect(fetchMock.mock.calls[1][0]).toContain('/messages/om_source/reply');
  });
});

describe('token caching', () => {
  it('reuses the tenant_access_token across calls within TTL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't1', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'm1' } }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'm2' } }) });
    globalThis.fetch = fetchMock;

    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'oc_x', text: '1' });
    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'oc_x', text: '2' });

    // 1 token fetch + 2 sends = 3 calls (not 4)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-fetches the tenant_access_token after TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't1', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'm1' } }) })
      // After TTL elapses, the skill must refetch — second token fetch.
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't2', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'm2' } }) });
    globalThis.fetch = fetchMock;

    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'oc_x', text: '1' });
    // Advance past the cache's 100-minute TTL.
    vi.setSystemTime(new Date('2026-01-01T01:50:01Z'));
    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'oc_x', text: '2' });

    // 2 token fetches + 2 sends = 4 calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});

describe('receive_id_type inference', () => {
  function setupSendMock() {
    return vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { message_id: 'om_1' } }) });
  }

  it('infers open_id from an "ou_*" id', async () => {
    globalThis.fetch = setupSendMock();
    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'ou_alice', text: 'hi' });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('receive_id_type=open_id');
  });

  it('infers union_id from an "on_*" id', async () => {
    globalThis.fetch = setupSendMock();
    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'on_union', text: 'hi' });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('receive_id_type=union_id');
  });

  it('infers email when the id contains "@"', async () => {
    globalThis.fetch = setupSendMock();
    await larkSkill.handleToolCall('lark_send_message', { receive_id: 'alice@zibby.dev', text: 'hi' });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('receive_id_type=email');
  });
});

describe('lark_list_chats', () => {
  it('maps the Lark response into a compact chats array', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({
        code: 0,
        data: { items: [
          { chat_id: 'oc_a', name: 'Eng', description: 'engineering', owner_id: 'ou_owner', chat_mode: 'group' },
          { chat_id: 'oc_b', name: 'DM', description: '', owner_id: 'ou_owner', chat_mode: 'p2p' },
        ] },
      }) });

    const result = JSON.parse(await larkSkill.handleToolCall('lark_list_chats', { page_size: 10 }));
    expect(result.chats).toHaveLength(2);
    expect(result.chats[0]).toEqual({
      chat_id: 'oc_a', name: 'Eng', description: 'engineering', owner_id: 'ou_owner', chat_mode: 'group',
    });
    // Page-size flows through to the URL.
    expect(globalThis.fetch.mock.calls[1][0]).toContain('page_size=10');
  });

  it('defaults page_size to 50 when omitted', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 0, data: { items: [] } }) });

    await larkSkill.handleToolCall('lark_list_chats', {});
    expect(globalThis.fetch.mock.calls[1][0]).toContain('page_size=50');
  });
});

describe('lark_get_chat_history', () => {
  it('fetches messages for a chat and projects the response', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) })
      .mockResolvedValueOnce({ json: async () => ({
        code: 0,
        data: { items: [
          {
            message_id: 'om_1',
            sender: { id: 'ou_alice', sender_type: 'user' },
            msg_type: 'text',
            body: { content: '{"text":"hi"}' },
            create_time: '1700000000000',
          },
        ] },
      }) });

    const result = JSON.parse(await larkSkill.handleToolCall('lark_get_chat_history', { chat_id: 'oc_x' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      message_id: 'om_1',
      sender_id: 'ou_alice',
      sender_type: 'user',
      msg_type: 'text',
      content: '{"text":"hi"}',
      create_time: '1700000000000',
    });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('container_id=oc_x');
    expect(globalThis.fetch.mock.calls[1][0]).toContain('sort_type=ByCreateTimeDesc');
  });

  it('errors when chat_id is missing', async () => {
    const result = JSON.parse(await larkSkill.handleToolCall('lark_get_chat_history', {}));
    expect(result.error).toMatch(/chat_id is required/);
  });
});
