import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

/** 连接电脑桥插件所需的配置。 */
export class BridgeConfig {
  host: string = '';
  port: number = 3088;
  token: string = '';
  proxyPort: number = 7627;

  baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  webUrl(): string {
    return `http://${this.host}:${this.proxyPort}/`;
  }

  valid(): boolean {
    return this.host.length > 0 && this.port > 0 && this.token.length > 0;
  }
}

const STORE_NAME: string = 'dshremote';
const KEY_HOST: string = 'host';
const KEY_PORT: string = 'port';
const KEY_TOKEN: string = 'token';
const KEY_PROXY_PORT: string = 'proxyPort';

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
    await store.flush();
  }
}
