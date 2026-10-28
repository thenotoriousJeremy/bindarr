const { performance } = require('perf_hooks');

const MAX_API_ROUTES = 500;

function createStats() {
  return {
    calls: 0,
    errors: 0,
    clientErrors: 0,
    serverErrors: 0,
    durationMs: 0,
    maxDurationMs: 0,
  };
}

function updateStats(stats, durationMs, status) {
  stats.calls++;
  stats.durationMs += durationMs;
  stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
  if (status >= 400) {
    stats.errors++;
    if (status >= 500) stats.serverErrors++;
    else stats.clientErrors++;
  }
}

function presentStats(stats) {
  return {
    calls: stats.calls,
    errors: stats.errors,
    clientErrors: stats.clientErrors,
    serverErrors: stats.serverErrors,
    totalDurationMs: stats.durationMs,
    averageDurationMs: stats.calls ? stats.durationMs / stats.calls : 0,
    maxDurationMs: stats.maxDurationMs,
  };
}

function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function createMetrics({ enabled = true } = {}) {
  const requestsByRoute = new Map();
  const providers = new Map();
  const providerOperations = new Map();
  const instrumentedClients = new WeakSet();

  function recordProviderCall(provider, startedAt, status, operation = 'api') {
    if (!enabled) return;
    if (!providers.has(provider)) providers.set(provider, createStats());
    if (!providerOperations.has(provider)) providerOperations.set(provider, new Map());
    const operations = providerOperations.get(provider);
    if (!operations.has(operation)) operations.set(operation, createStats());
    const durationMs = startedAt === undefined ? 0 : Math.max(0, performance.now() - startedAt);
    updateStats(providers.get(provider), durationMs, status);
    updateStats(operations.get(operation), durationMs, status);
  }

  function middleware(req, res, next) {
    if (!enabled || !req.path.startsWith('/api/')) return next();

    const startedAt = performance.now();
    res.once('finish', () => {
      const method = String(req.method || 'UNKNOWN').toUpperCase();
      const routePath = req.route ? String(req.baseUrl || '') + String(req.route.path) : 'unmatched';
      const key = `${method} ${routePath}`;
      const metricKey = requestsByRoute.has(key) || requestsByRoute.size < MAX_API_ROUTES
        ? key
        : 'OTHER';
      if (!requestsByRoute.has(metricKey)) requestsByRoute.set(metricKey, createStats());
      updateStats(requestsByRoute.get(metricKey), Math.max(0, performance.now() - startedAt), res.statusCode || 200);
    });
    next();
  }

  function instrumentAxiosClient(client, provider) {
    if (!enabled) return client;
    if (!client || !client.interceptors || instrumentedClients.has(client)) {
      if (instrumentedClients.has(client)) return client;
      throw new TypeError('Expected an Axios client to instrument');
    }

    instrumentedClients.add(client);
    client.interceptors.request.use(config => {
      config.__bindarrMetricsStartedAt = performance.now();
      return config;
    });
    client.interceptors.response.use(
      response => {
        recordProviderCall(provider, response.config?.__bindarrMetricsStartedAt, response.status || 200);
        return response;
      },
      error => {
        const status = error.response?.status || 500;
        recordProviderCall(provider, error.config?.__bindarrMetricsStartedAt, status);
        return Promise.reject(error);
      }
    );
    return client;
  }

  function snapshot() {
    const routes = [...requestsByRoute.entries()]
      .map(([route, stats]) => ({ route, ...presentStats(stats) }))
      .sort((a, b) => b.calls - a.calls);
    const providerMetrics = [...providers.entries()]
      .map(([provider, stats]) => ({
        provider,
        ...presentStats(stats),
        operations: [...providerOperations.get(provider).entries()]
          .map(([operation, operationStats]) => ({ operation, ...presentStats(operationStats) }))
          .sort((a, b) => b.calls - a.calls),
      }))
      .sort((a, b) => b.calls - a.calls);
    const totals = [...requestsByRoute.values()].reduce((total, stats) => {
      total.calls += stats.calls;
      total.errors += stats.errors;
      total.clientErrors += stats.clientErrors;
      total.serverErrors += stats.serverErrors;
      total.durationMs += stats.durationMs;
      total.maxDurationMs = Math.max(total.maxDurationMs, stats.maxDurationMs);
      return total;
    }, createStats());

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      requests: { ...presentStats(totals), routes },
      providers: providerMetrics,
    };
  }

  function toPrometheus(collection = {
    userCount: 0,
    totalCards: 0,
    uniqueCards: 0,
    totalValue: 0,
    cardsAdded30d: 0,
    users: [],
    types: [],
  }) {
    const data = snapshot();
    const lines = [
      '# HELP bindarr_process_uptime_seconds Process uptime in seconds.',
      '# TYPE bindarr_process_uptime_seconds gauge',
      `bindarr_process_uptime_seconds ${data.uptimeSeconds}`,
      '# HELP bindarr_process_memory_bytes Process memory usage by type.',
      '# TYPE bindarr_process_memory_bytes gauge',
    ];
    for (const [type, bytes] of Object.entries(data.memory)) {
      lines.push(`bindarr_process_memory_bytes{type="${escapeLabel(type)}"} ${bytes}`);
    }

    lines.push(
      '# HELP bindarr_collection_users Number of registered users.',
      '# TYPE bindarr_collection_users gauge',
      `bindarr_collection_users ${collection.userCount}`,
      '# HELP bindarr_collection_cards Number of cards and unique collection entries.',
      '# TYPE bindarr_collection_cards gauge',
      `bindarr_collection_cards{kind="owned"} ${collection.totalCards}`,
      `bindarr_collection_cards{kind="entries"} ${collection.uniqueCards}`,
      '# HELP bindarr_collection_estimated_value Estimated total collection market value in Bindarr pricing units.',
      '# TYPE bindarr_collection_estimated_value gauge',
      `bindarr_collection_estimated_value ${collection.totalValue}`,
      '# HELP bindarr_collection_cards_added_30d Cards added to collections in the last 30 days.',
      '# TYPE bindarr_collection_cards_added_30d gauge',
      `bindarr_collection_cards_added_30d ${collection.cardsAdded30d}`,
      '# HELP bindarr_collection_user_cards Cards and unique entries in each user collection.',
      '# TYPE bindarr_collection_user_cards gauge',
      '# HELP bindarr_collection_user_estimated_value Estimated market value of each user collection in Bindarr pricing units.',
      '# TYPE bindarr_collection_user_estimated_value gauge',
      '# HELP bindarr_collection_user_cards_added_30d Cards added to each user collection in the last 30 days.',
      '# TYPE bindarr_collection_user_cards_added_30d gauge',
    );
    for (const user of collection.users) {
      const labels = `user_id="${escapeLabel(user.id)}",username="${escapeLabel(user.username)}"`;
      lines.push(`bindarr_collection_user_cards{${labels},kind="owned"} ${user.total_cards}`);
      lines.push(`bindarr_collection_user_cards{${labels},kind="entries"} ${user.unique_cards}`);
      lines.push(`bindarr_collection_user_estimated_value{${labels}} ${user.total_value}`);
      lines.push(`bindarr_collection_user_cards_added_30d{${labels}} ${user.cards_added_30d}`);
    }

    lines.push(
      '# HELP bindarr_collection_cards_by_type Cards by user, game, and card type.',
      '# TYPE bindarr_collection_cards_by_type gauge',
    );
    for (const item of collection.types) {
      const labels = `user_id="${escapeLabel(item.userId)}",username="${escapeLabel(item.username)}",game="${escapeLabel(item.game)}",type="${escapeLabel(item.name)}"`;
      lines.push(`bindarr_collection_cards_by_type{${labels}} ${item.cards}`);
    }

    lines.push(
      '# HELP bindarr_http_requests_completed API requests completed since process start.',
      '# TYPE bindarr_http_requests_completed gauge',
      `bindarr_http_requests_completed ${data.requests.calls}`,
      '# HELP bindarr_http_request_errors API requests completed with an error status since process start.',
      '# TYPE bindarr_http_request_errors gauge',
      `bindarr_http_request_errors ${data.requests.errors}`,
      '# HELP bindarr_http_request_average_duration_seconds Average API request duration since process start.',
      '# TYPE bindarr_http_request_average_duration_seconds gauge',
      `bindarr_http_request_average_duration_seconds ${data.requests.averageDurationMs / 1000}`,
      '# HELP bindarr_http_request_max_duration_seconds Maximum API request duration since process start.',
      '# TYPE bindarr_http_request_max_duration_seconds gauge',
      `bindarr_http_request_max_duration_seconds ${data.requests.maxDurationMs / 1000}`,
      '# HELP bindarr_http_requests_total API requests completed.',
      '# TYPE bindarr_http_requests_total counter',
      '# HELP bindarr_http_request_errors_total API requests completed with an error status.',
      '# TYPE bindarr_http_request_errors_total counter',
      '# HELP bindarr_http_request_duration_seconds API request duration in seconds.',
      '# TYPE bindarr_http_request_duration_seconds summary',
    );
    for (const item of data.requests.routes) {
      const separator = item.route.indexOf(' ');
      const method = separator < 0 ? 'UNKNOWN' : item.route.slice(0, separator);
      const route = separator < 0 ? item.route : item.route.slice(separator + 1);
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
      lines.push(`bindarr_http_requests_total{${labels}} ${item.calls}`);
      lines.push(`bindarr_http_request_max_duration_seconds{${labels}} ${item.maxDurationMs / 1000}`);
      if (item.clientErrors) {
        lines.push(`bindarr_http_request_errors_total{${labels},status_class="4xx"} ${item.clientErrors}`);
      }
      if (item.serverErrors) {
        lines.push(`bindarr_http_request_errors_total{${labels},status_class="5xx"} ${item.serverErrors}`);
      }
      lines.push(`bindarr_http_request_duration_seconds_sum{${labels}} ${item.totalDurationMs / 1000}`);
      lines.push(`bindarr_http_request_duration_seconds_count{${labels}} ${item.calls}`);
    }

    lines.push(
      '# HELP bindarr_upstream_requests_total Upstream provider calls completed.',
      '# TYPE bindarr_upstream_requests_total counter',
      '# HELP bindarr_upstream_requests_by_operation_total Upstream provider calls by operation.',
      '# TYPE bindarr_upstream_requests_by_operation_total counter',
      '# HELP bindarr_upstream_request_errors_total Upstream provider calls that failed.',
      '# TYPE bindarr_upstream_request_errors_total counter',
      '# HELP bindarr_upstream_request_average_duration_seconds Average upstream provider call duration since process start.',
      '# TYPE bindarr_upstream_request_average_duration_seconds gauge',
      '# HELP bindarr_upstream_request_max_duration_seconds Maximum upstream provider call duration since process start.',
      '# TYPE bindarr_upstream_request_max_duration_seconds gauge',
      '# HELP bindarr_upstream_request_duration_seconds Upstream provider call duration in seconds.',
      '# TYPE bindarr_upstream_request_duration_seconds summary',
    );
    for (const item of data.providers) {
      const label = `provider="${escapeLabel(item.provider)}"`;
      lines.push(`bindarr_upstream_requests_total{${label}} ${item.calls}`);
      for (const operation of item.operations) {
        lines.push(`bindarr_upstream_requests_by_operation_total{${label},operation="${escapeLabel(operation.operation)}"} ${operation.calls}`);
      }
      if (item.errors) lines.push(`bindarr_upstream_request_errors_total{${label}} ${item.errors}`);
      lines.push(`bindarr_upstream_request_average_duration_seconds{${label}} ${item.averageDurationMs / 1000}`);
      lines.push(`bindarr_upstream_request_max_duration_seconds{${label}} ${item.maxDurationMs / 1000}`);
      lines.push(`bindarr_upstream_request_duration_seconds_sum{${label}} ${item.totalDurationMs / 1000}`);
      lines.push(`bindarr_upstream_request_duration_seconds_count{${label}} ${item.calls}`);
    }
    return `${lines.join('\n')}\n`;
  }

  return { middleware, instrumentAxiosClient, recordProviderCall, snapshot, toPrometheus };
}

const isEnabled = value => ['true', '1'].includes(String(value || '').toLowerCase());
const adminEnabled = isEnabled(process.env.METRICS_ENABLED);
const prometheusEnabled = isEnabled(process.env.PROMETHEUS_METRICS_ENABLED);
const metrics = createMetrics({ enabled: adminEnabled || prometheusEnabled });
metrics.adminEnabled = adminEnabled;
metrics.prometheusEnabled = prometheusEnabled;
metrics.createMetrics = createMetrics;

module.exports = metrics;
