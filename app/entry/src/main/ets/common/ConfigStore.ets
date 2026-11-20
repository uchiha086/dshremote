import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

/** 连接电脑桥插件所需的配置。 */
export class BridgeConfig {
  host: string = '';
  port: number = 3088;
  token: string = '';
  proxyPort: number = 7627;
  /** 隧道地址（https://xxx.trycloudflare.com），填了就走公网，忽略 host/port/proxyPort。 */
  tunnel: string = '';

  /** 桥插件自己的 HTTP 接口（/health、/events、/auth/cookie）的根地址。 */
  baseUrl(): string {
    const tunnel = this.tunnelUrl();
    if (tunnel.length > 0) {
      return tunnel;
    }
    return `http://${this.host}:${this.port}`;
  }

  /** 塞进 WebView 的 DSH 首页地址。 */
  webUrl(): string {
    const tunnel = this.tunnelUrl();
    if (tunnel.length > 0) {
      return `${tunnel}/`;
    }
    return `http://${this.host}:${this.proxyPort}/`;
  }

  /** 去掉结尾斜杠；不是合法 http(s) 地址就返回空串。 */
  tunnelUrl(): string {
    let value = this.tunnel.trim();
    while (value.endsWith('/')) {
      value = value.substring(0, value.length - 1);
    }
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      return '';
    }
    return value;
  }

  valid(): boolean {
    if (this.tunnelUrl().length > 0) {
      return this.token.length > 0;
    }
    return this.host.length > 0 && this.port > 0 && this.token.length > 0;
  }
}

const STORE_NAME: string = 'dshremote';
const KEY_HOST: string = 'host';
const KEY_PORT: string = 'port';
const KEY_TOKEN: string = 'token';
const KEY_PROXY_PORT: string = 'proxyPort';
const KEY_TUNNEL: string = 'tunnel';

/** 用 Preferences 持久化配置，App 重启后不用重新配对。 */
export class ConfigStore {
  private static store: preferences.Preferences | null = null;

  static async init(context: common.UIAbilityContext): Promise<void> {
    if (ConfigStore.store === null) {
      ConfigStore.store = await preferences.getPreferences(context, { name: STORE_NAME });
    }
  }

  static async load(): Promise<BridgeConfig> {
    const cfg = new BridgeConfig();
    const store = ConfigStore.store;
    if (store === null) {
      return cfg;
    }
    cfg.host = String(await store.get(KEY_HOST, ''));
    cfg.port = Number(await store.get(KEY_PORT, 3088));
    cfg.token = String(await store.get(KEY_TOKEN, ''));
    cfg.proxyPort = Number(await store.get(KEY_PROXY_PORT, 7627));
    cfg.tunnel = String(await store.get(KEY_TUNNEL, ''));
    return cfg;
  }

  static async save(cfg: BridgeConfig): Promise<void> {
    const store = ConfigStore.store;
    if (store === null) {
      return;
    }
    await store.put(KEY_HOST, cfg.host);
    await store.put(KEY_PORT, cfg.port);
    await store.put(KEY_TOKEN, cfg.token);
    await store.put(KEY_PROXY_PORT, cfg.proxyPort);
    await store.put(KEY_TUNNEL, cfg.tunnel);
    await store.flush();
  }

  static async clear(): Promise<void> {
    const store = ConfigStore.store;
    if (store === null) {
      return;
    }
    await store.delete(KEY_HOST);
    await store.delete(KEY_PORT);
    await store.delete(KEY_TOKEN);
    await store.delete(KEY_PROXY_PORT);
    await store.delete(KEY_TUNNEL);
    await store.flush();
  }
}
