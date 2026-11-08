// What each notification channel is sent: one message, four wire formats.
//
// A message is { type, level, title, body, data }:
//   type   the event ('price_moves', 'backup_failed', 'test', ...)
//   level  'info' | 'warning' | 'failure'
//   title  one line
//   body   plain text, newline-separated
//   data   the structured event, for the generic webhook only
//
// Pure functions, so test/notify.test.js can hold each format to the shape its
// receiver documents without a network.

const CHANNEL_TYPES = ['discord', 'ntfy', 'webhook', 'apprise'];

const clip = (s, n) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Discord embed colours, matching the app's accents closely enough to read.
const DISCORD_COLOR = { info: 0x3b82f6, warning: 0xf59e0b, failure: 0xef4444 };

// https://discord.com/developers/docs/resources/webhook#execute-webhook
// Embed limits: title 256, description 4096.
function discord(message) {
  return {
    username: 'Bindarr',
    embeds: [{
      title: clip(message.title, 256),
      description: clip(message.body, 4096),
      color: DISCORD_COLOR[message.level] || DISCORD_COLOR.info,
      timestamp: new Date().toISOString(),
    }],
    // A card named "@everyone" must not ping a whole server.
    allowed_mentions: { parse: [] },
  };
}

// https://docs.ntfy.sh/publish/#publish-as-json — POSTed to the server ROOT, with
// the topic in the body.
const NTFY_PRIORITY = { info: 3, warning: 4, failure: 5 };
const NTFY_TAGS = { info: ['chart_with_upwards_trend'], warning: ['warning'], failure: ['rotating_light'] };
function ntfy(message, channel) {
  return {
    topic: channel.topic,
    title: clip(message.title, 250),
    message: clip(message.body, 4000),
    priority: NTFY_PRIORITY[message.level] || 3,
    tags: message.type === 'test' ? ['white_check_mark'] : (NTFY_TAGS[message.level] || []),
  };
}

// https://github.com/caronc/apprise-api#stateful-solution — POST /notify/{KEY}
// (or the stateless /notify with urls configured server-side).
function apprise(message) {
  return {
    title: clip(message.title, 250),
    body: clip(message.body, 10000),
    type: message.level === 'failure' ? 'failure' : message.level === 'warning' ? 'warning' : 'info',
    format: 'text',
  };
}

// Our own documented shape, for anything else (Home Assistant, n8n, a script).
function webhook(message) {
  return {
    source: 'bindarr',
    event: message.type,
    level: message.level,
    title: message.title,
    message: message.body,
    data: message.data || {},
    sent_at: new Date().toISOString(),
  };
}

const BUILDERS = { discord, ntfy, apprise, webhook };

// The URL to POST to. ntfy's JSON publish goes to the server root whatever path
// the user typed for the server; the others use the stored URL as-is.
function targetUrl(channel) {
  if (channel.type === 'ntfy') {
    const u = new URL(channel.url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
  }
  return channel.url;
}

// { url, body, headers } for one channel. The token travels as a bearer header —
// ntfy's access tokens and most webhook receivers take it that way.
function buildRequest(channel, message) {
  const build = BUILDERS[channel.type];
  if (!build) throw new Error(`unknown channel type ${channel.type}`);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Bindarr' };
  if (channel.token && (channel.type === 'ntfy' || channel.type === 'webhook' || channel.type === 'apprise')) {
    headers.Authorization = `Bearer ${channel.token}`;
  }
  return { url: targetUrl(channel), body: build(message, channel), headers };
}

// Money for a message body. Not the app's locale-aware formatter (that lives in
// the frontend): a notification has no viewer locale, so it says the currency.
function money(amount, currency) {
  const n = Number(amount);
  const sym = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[currency];
  const fixed = n.toFixed(currency === 'JPY' ? 0 : 2);
  return sym ? `${sym}${fixed}` : `${fixed} ${currency || ''}`.trim();
}

// The price-move digest: one message per user per sweep, not one per card, so a
// market-wide move does not become fifty pings (and fifty Discord rate-limit hits).
const MAX_LINES = 20;
function priceMovesMessage(moves) {
  const ups = moves.filter(m => m.new_price > m.old_price).length;
  const lines = moves.slice(0, MAX_LINES).map(m => {
    const pct = m.old_price > 0 ? ((m.new_price - m.old_price) / m.old_price) * 100 : 0;
    const arrow = m.new_price > m.old_price ? '▲' : '▼';
    const where = m.source === 'wishlist' ? ' (wishlist)' : '';
    const set = m.set_name ? ` · ${m.set_name}` : '';
    return `${arrow} ${m.name}${set}${where}: ${money(m.old_price, m.currency)} → ${money(m.new_price, m.currency)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
  });
  if (moves.length > MAX_LINES) lines.push(`…and ${moves.length - MAX_LINES} more`);
  return {
    type: 'price_moves',
    level: 'info',
    title: moves.length === 1
      ? `Price move: ${moves[0].name}`
      : `${moves.length} price moves (${ups} up, ${moves.length - ups} down)`,
    body: lines.join('\n'),
    data: { moves },
  };
}

// Admin events: a failed sweep, backup or catalog build.
function adminMessage(event) {
  const error = clip(event.error || 'unknown error', 500);
  if (event.type === 'price_sweep_failed') {
    return { type: event.type, level: 'failure', title: `Price sweep failed: ${event.source}`, body: error, data: { source: event.source, error } };
  }
  if (event.type === 'backup_failed') {
    return { type: event.type, level: 'failure', title: 'Backup failed', body: error, data: { error } };
  }
  if (event.type === 'catalog_build_failed') {
    const which = [event.game, event.lang].filter(Boolean).join('/');
    return { type: event.type, level: 'failure', title: `Scan catalog build failed: ${which}`, body: error, data: { game: event.game, lang: event.lang, error } };
  }
  return null;
}

function testMessage() {
  return {
    type: 'test',
    level: 'info',
    title: 'Bindarr test notification',
    body: 'If you can read this, this channel works.',
    data: {},
  };
}

module.exports = { CHANNEL_TYPES, buildRequest, targetUrl, priceMovesMessage, adminMessage, testMessage, money };
