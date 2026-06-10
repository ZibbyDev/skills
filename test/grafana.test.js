import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { grafanaSkill } = await import('../src/grafana.js');

// Helper — build a `fetch` response with a JSON body. Grafana returns 2xx
// JSON on success; gfFetch checks res.ok then parses.
function fetchOk(payload, status = 200) {
  return { ok: true, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function fetchErr(status, body = '') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.GRAFANA_URL = 'https://grafana.example.com';
  process.env.GRAFANA_TOKEN = 'glsa_test_token';
  delete process.env.GRAFANA_API_URL;
  delete process.env.GRAFANA_INSTANCE_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('grafanaSkill structure', () => {
  it('is registered with the expected id', () => {
    expect(grafanaSkill.id).toBe('grafana');
    expect(grafanaSkill.serverName).toBe('grafana');
  });

  it('exposes the expected tools', () => {
    const names = grafanaSkill.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'grafana_get_dashboard',
      'grafana_list_alert_rules',
      'grafana_list_datasources',
      'grafana_list_firing_alerts',
      'grafana_query',
      'grafana_search_dashboards',
    ]);
  });

  it('does NOT declare a requiresIntegration (env-configured, not a backend OAuth integration)', () => {
    expect(grafanaSkill.requiresIntegration).toBeUndefined();
  });

  it('declares the env keys it reads', () => {
    expect(grafanaSkill.envKeys).toEqual(
      expect.arrayContaining(['GRAFANA_URL', 'GRAFANA_TOKEN', 'GRAFANA_INSTANCE_URL', 'GRAFANA_API_URL']),
    );
  });

  it('grafana_get_dashboard requires uid', () => {
    const tool = grafanaSkill.tools.find((t) => t.name === 'grafana_get_dashboard');
    expect(tool.input_schema.required).toEqual(['uid']);
  });

  it('grafana_query requires datasourceUid + expr', () => {
    const tool = grafanaSkill.tools.find((t) => t.name === 'grafana_query');
    expect(tool.input_schema.required).toEqual(['datasourceUid', 'expr']);
  });
});

describe('grafana_search_dashboards (happy path)', () => {
  it('hits /api/search?type=dash-db and maps the results', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk([
      { uid: 'abc', title: 'API latency', url: '/d/abc/api', folderTitle: 'Prod', tags: ['api'] },
      { uid: 'def', title: 'DB', url: '/d/def/db', tags: [] },
    ]));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_search_dashboards', { query: 'api', tag: 'api' }));
    expect(result.count).toBe(2);
    expect(result.dashboards[0]).toEqual({
      uid: 'abc', title: 'API latency', url: '/d/abc/api', folderTitle: 'Prod', tags: ['api'],
    });
    // URL was built against GRAFANA_URL + /api/search with the right params.
    const calledUrl = globalThis.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('https://grafana.example.com/api/search?');
    expect(calledUrl).toContain('type=dash-db');
    expect(calledUrl).toContain('query=api');
    expect(calledUrl).toContain('tag=api');
    // Bearer token attached.
    const opts = globalThis.fetch.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer glsa_test_token');
  });
});

describe('grafana_get_dashboard (panel summary, not full JSON)', () => {
  it('summarizes panels to {id,title,type}', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      meta: { url: '/d/abc/api', folderTitle: 'Prod', updated: '2026-06-01' },
      dashboard: {
        uid: 'abc', title: 'API latency', version: 7, tags: ['api'],
        panels: [
          { id: 1, title: 'p99', type: 'timeseries', targets: [{ expr: 'big...' }] },
          { id: 2, title: 'errors', type: 'stat' },
        ],
      },
    }));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_get_dashboard', { uid: 'abc' }));
    expect(result.uid).toBe('abc');
    expect(result.panelCount).toBe(2);
    expect(result.panels).toEqual([
      { id: 1, title: 'p99', type: 'timeseries' },
      { id: 2, title: 'errors', type: 'stat' },
    ]);
  });

  it('rejects missing uid', async () => {
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_get_dashboard', {}));
    expect(result.error).toMatch(/uid is required/);
  });
});

describe('grafana_list_datasources', () => {
  it('maps to {uid,name,type}', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk([
      { uid: 'prom1', name: 'Prometheus', type: 'prometheus', extra: 'dropped' },
      { uid: 'loki1', name: 'Loki', type: 'loki' },
    ]));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_list_datasources', {}));
    expect(result.datasources).toEqual([
      { uid: 'prom1', name: 'Prometheus', type: 'prometheus' },
      { uid: 'loki1', name: 'Loki', type: 'loki' },
    ]);
  });
});

describe('grafana_query (POST /api/ds/query, Prometheus model)', () => {
  it('posts an instant query and summarizes frames into series', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk({
      results: {
        A: {
          frames: [{
            schema: { fields: [
              { name: 'Time', type: 'time' },
              { name: 'Value', type: 'number', labels: { job: 'api' } },
            ] },
            data: { values: [[1700000000000], [42]] },
          }],
        },
      },
    }));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_query', {
      datasourceUid: 'prom1', expr: 'up{job="api"}',
    }));
    expect(result.instant).toBe(true);
    expect(result.seriesCount).toBe(1);
    expect(result.series[0].labels).toEqual({ job: 'api' });

    // Verify it POSTed to /api/ds/query with the prometheus query model.
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://grafana.example.com/api/ds/query');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.queries[0].expr).toBe('up{job="api"}');
    expect(body.queries[0].datasource).toEqual({ uid: 'prom1' });
    expect(body.queries[0].instant).toBe(true);
  });

  it('rejects missing datasourceUid/expr', async () => {
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_query', { expr: 'up' }));
    expect(result.error).toMatch(/datasourceUid and expr are required/);
  });
});

describe('grafana_list_firing_alerts', () => {
  it('maps active alerts with labels + state', async () => {
    globalThis.fetch = vi.fn(async () => fetchOk([
      {
        status: { state: 'active' },
        labels: { alertname: 'HighErrorRate', severity: 'critical' },
        annotations: { summary: 'errors high' },
        startsAt: '2026-06-11T00:00:00Z',
      },
    ]));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_list_firing_alerts', {}));
    expect(result.count).toBe(1);
    expect(result.alerts[0]).toMatchObject({
      state: 'active',
      labels: { alertname: 'HighErrorRate', severity: 'critical' },
    });
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/alertmanager/grafana/api/v2/alerts?active=true');
  });
});

describe('error / missing-env paths', () => {
  it('returns a clear error (no crash) when GRAFANA_URL is unset', async () => {
    delete process.env.GRAFANA_URL;
    delete process.env.GRAFANA_INSTANCE_URL;
    delete process.env.GRAFANA_API_URL;
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_list_datasources', {}));
    expect(result.error).toMatch(/GRAFANA_URL/);
  });

  it('returns a clear error (no crash) when GRAFANA_TOKEN is unset', async () => {
    delete process.env.GRAFANA_TOKEN;
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_list_datasources', {}));
    expect(result.error).toMatch(/GRAFANA_TOKEN/);
  });

  it('surfaces a non-2xx API error with status + body snippet', async () => {
    globalThis.fetch = vi.fn(async () => fetchErr(403, 'permission denied'));
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_list_alert_rules', {}));
    expect(result.error).toMatch(/Grafana API 403/);
    expect(result.error).toMatch(/permission denied/);
  });

  it('returns an Unknown tool error for an unrecognized name', async () => {
    const result = JSON.parse(await grafanaSkill.handleToolCall('grafana_bogus', {}));
    expect(result.error).toMatch(/Unknown tool/);
  });
});
