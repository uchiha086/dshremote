import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

/** 桥插件在局域网里广播的内容。 */
export interface Beacon {
  svc: string;
  v: number;
  name: string;
  port: number;
  proxy: number;
  lan: string[];
  public: string;
  token: string;
}

/** 一台被发现到的电脑（已经整理成 App 能直接用的地址）。 */
export class FoundHost {
  name: string = '';
  base: string = '';
  web: string = '';
  token: string = '';
  publicUrl: string = '';
}

/**
 * 局域网自动发现：桥插件每 2 秒往 UDP 3089 广播一次自己，
 * 这里监听同一个端口，收到就把「电脑名 + 地址 + token」交给界面，用户点一下就能连。
 */
export class Discovery {
  private udp: socket.UDPSocket | null = null;
  private found: boolean = false;
  private started: boolean = false;
  onFound: (host: FoundHost) => void = () => {};
  onError: (message: string) => void = () => {};

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const udp = socket.constructUDPSocketInstance();
    this.udp = udp;
    udp.on('message', (value: socket.SocketMessageInfo) => {
      try {
        const decoder = util.TextDecoder.create('utf-8');
        const bytes = new Uint8Array(value.message);
        const text = decoder.decodeWithStream(bytes, { stream: false });
        const beacon = JSON.parse(text) as Beacon;
        if (beacon.svc !== 'dshremote' || !beacon.token || this.found) {
          return;
        }
        const ip = beacon.lan && beacon.lan.length > 0 ? beacon.lan[0] : '';
        if (ip.length === 0 && (!beacon.public || beacon.public.length === 0)) {
          return;
        }
        const host = new FoundHost();
        host.name = beacon.name ? beacon.name : '电脑';
        host.token = beacon.token;
        host.publicUrl = beacon.public ? beacon.public : '';
        if (ip.length > 0) {
          host.base = `http://${ip}:${beacon.port}`;
          host.web = `http://${ip}:${beacon.proxy}`;
        } else {
          host.base = host.publicUrl;
          host.web = host.publicUrl;
        }
        this.found = true;
        this.onFound(host);
      } catch (error) {
        // 收到的不是我们的报文，忽略。
      }
    });
    udp.on('error', (error: Error) => {
      this.onError(`发现失败 ${error.message}`);
    });
    udp.bind({ address: '0.0.0.0', port: 3089, family: 1 }).catch((error: Error) => {
      this.onError(`监听广播失败 ${error.message}`);
    });
  }

  stop(): void {
    if (this.udp) {
      this.udp.off('message');
      this.udp.close().catch(() => {});
      this.udp = null;
    }
    this.started = false;
    this.found = false;
  }
}
