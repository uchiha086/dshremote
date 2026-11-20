import { BridgeConfig } from './ConfigStore';

/** 配对链接解析结果。base/web 可能是局域网 http，也可能是隧道 https。 */
export class PairResult {
  ok: boolean = false;
  error: string = '';
  name: string = '';
  host: string = '';
  port: number = 3088;
  proxyPort: number = 7627;
  tunnel: string = '';
  token: string = '';
}

class ParsedHttp {
  ok: boolean = false;
  host: string = '';
  port: number = 0;
}

/** 解析 http://host:port 这种地址，够用就行，不引入 URL 依赖。 */
function parseHttp(value: string): ParsedHttp {
  const out = new ParsedHttp();
  if (!value.startsWith('http://')) {
    return out;
  }
  const rest = value.substring('http://'.length);
  const slash = rest.indexOf('/');
  const authority = slash >= 0 ? rest.substring(0, slash) : rest;
  const colon = authority.lastIndexOf(':');
  if (colon > 0) {
    out.host = authority.substring(0, colon);
    const port = Number(authority.substring(colon + 1));
    out.port = Number.isFinite(port) && port > 0 ? port : 80;
  } else {
    out.host = authority;
    out.port = 80;
  }
  out.ok = out.host.length > 0;
  return out;
}

/**
 * 解析电脑上生成的配对链接：
 * dshremote://pair?v=1&name=<电脑名>&base=<地址>&web=<网页地址>&token=<口令>
 */
export function parsePairing(raw: string): PairResult {
  const out = new PairResult();
  const text = (raw || '').trim();
  const prefix = 'dshremote://pair?';
  if (!text.startsWith(prefix)) {
    out.error = '这不是 DSH Remote 的配对码';
    return out;
  }
  const fields = new Map<string, string>();
  for (const pair of text.substring(prefix.length).split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const eq = pair.indexOf('=');
    if (eq < 0) {
      continue;
    }
    fields.set(pair.substring(0, eq), decodeURIComponent(pair.substring(eq + 1)));
  }
  const base = fields.get('base') ?? '';
  const web = fields.get('web') ?? base;
  const tunnel = fields.get('tunnel') ?? '';
  const token = fields.get('token') ?? '';
  if (token.length < 16) {
    out.error = '配对码里没有有效的 token';
    return out;
  }
  out.token = token;
  out.name = fields.get('name') ?? '电脑';
  // 先解析局域网地址（可能没有，比如只有隧道时）
  if (base.startsWith('https://')) {
    out.tunnel = base.replace(/\/+$/, '');
  } else if (base.length > 0) {
    const parsed = parseHttp(base);
    if (parsed.ok) {
      out.host = parsed.host;
      out.port = parsed.port;
      const parsedWeb = parseHttp(web);
      out.proxyPort = parsedWeb.ok ? parsedWeb.port : 7627;
    }
  }
  // 二维码同时带局域网 + 公网时，两个都留下：先在局域网直连，不行再自动走隧道。
  if (tunnel.startsWith('https://')) {
    out.tunnel = tunnel.replace(/\/+$/, '');
  }
  if (out.tunnel.length === 0 && out.host.length === 0) {
    out.error = '配对码里的地址看不懂';
    return out;
  }
  out.ok = true;
  return out;
}

/** 把解析结果写进配置对象（不动全局状态，便于测试）。 */
export function applyPairing(cfg: BridgeConfig, result: PairResult): void {
  cfg.token = result.token;
  cfg.tunnel = result.tunnel;
  if (result.host.length > 0) {
    cfg.host = result.host;
    cfg.port = result.port;
    cfg.proxyPort = result.proxyPort;
  }
  // 两个地址都有时先试局域网；只有隧道就直接走公网。
  cfg.preferTunnel = result.host.length === 0 && result.tunnel.length > 0;
}
