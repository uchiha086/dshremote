import { http, webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

/** /health 的返回。 */
interface HealthResult {
  ok: boolean;
  service: string;
  version: string;
  protocol: number;
}

/** /auth/url 的返回：带进程令牌的一次性登录地址。 */
interface AuthUrlResult {
  ok: boolean;
  url: string;
}

/** 桥插件推来的帧，字段按需取。 */
interface WireFrame {
  type: string;
  sessionId: string;
  sessionTitle: string;
  question: string;
  answerHead: string;
  status: string;
  turn: number;
  proxyPort: number;
  ts: number;
}

/** 一条"回合结束"事件，手机据此弹通知。 */
export class TurnEndEvent {
  sessionId: string = '';
  sessionTitle: string = '';
  question: string = '';
  answerHead: string = '';
  status: string = 'done';
  turn: number = 0;
}

function parseJson(text: string): WireFrame | null {
  try {
    return JSON.parse(text) as WireFrame;
  } catch (error) {
    return null;
  }
}

/** 电脑侧桥插件的 HTTP 接口。 */
export class BridgeHttp {
  /** 探测 /health，返回可直接展示的文案。 */
  static async health(baseUrl: string): Promise<string> {
    const client = http.createHttp();
    try {
      const response = await client.request(`${baseUrl}/health`, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 5000
      });
      if (response.responseCode !== 200) {
        return `HTTP ${response.responseCode}`;
      }
      const body = JSON.parse(String(response.result)) as HealthResult;
      return `桥 ${body.version} · 协议 v${body.protocol}`;
    } catch (error) {
      const err = error as BusinessError;
      return `连不上：${err.message}`;
    } finally {
      client.destroy();
    }
  }

  /** 向桥要点免一次登录的 DSH Web 地址（打开一次后 cookie 长期有效）。 */
  static async authUrl(baseUrl: string, token: string, targetBase: string): Promise<string> {
    const client = http.createHttp();
    try {
      const url = `${baseUrl}/auth/url?token=${encodeURIComponent(token)}&base=${encodeURIComponent(targetBase)}`;
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 5000
      });
      if (response.responseCode !== 200) {
        return '';
      }
      const body = JSON.parse(String(response.result)) as AuthUrlResult;
      return body.ok ? body.url : '';
    } catch (error) {
      return '';
    } finally {
      client.destroy();
    }
  }
}

/** 与桥插件的 WebSocket 长连接：负责鉴权、心跳与推送解析。 */
export class BridgeSocket {
  private ws: webSocket.WebSocket | null = null;
  private heartbeat: number = -1;
  private reconnectTimer: number = -1;
  private closedByUser: boolean = false;
  private host: string = '';
  private port: number = 0;
  private token: string = '';

  onStatus: (text: string) => void = (text: string) => {
  };
  onTurnEnd: (event: TurnEndEvent) => void = (event: TurnEndEvent) => {
  };

  connect(host: string, port: number, token: string): void {
    this.host = host;
    this.port = port;
    this.token = token;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.teardown();
    const ws = webSocket.createWebSocket();
    this.ws = ws;

    ws.on('open', () => {
      this.onStatus('已连接');
      ws.send(JSON.stringify({ type: 'auth', token: this.token, deviceName: 'HOP-AL10' }));
      this.startHeartbeat();
    });

    ws.on('message', (err: BusinessError, data: string | ArrayBuffer) => {
      if (err) {
        return;
      }
      const text = typeof data === 'string' ? data : '';
      const frame = parseJson(text);
      if (frame === null) {
        return;
      }
      if (frame.type === 'hello') {
        this.onStatus(`已连接 · 桥 ${frame.ts > 0 ? 'v1' : 'v1'}`);
        return;
      }
      if (frame.type === 'turn_end') {
        const event = new TurnEndEvent();
        event.sessionId = frame.sessionId;
        event.sessionTitle = frame.sessionTitle;
        event.question = frame.question;
        event.answerHead = frame.answerHead;
        event.status = frame.status;
        event.turn = frame.turn;
        this.onTurnEnd(event);
      }
    });

    ws.on('close', () => {
      this.stopHeartbeat();
      this.onStatus('已断开');
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      this.stopHeartbeat();
      this.onStatus('连接出错');
    });

    ws.connect(`ws://${this.host}:${this.port}/ws`, {
      header: { 'Sec-WebSocket-Protocol': 'dshremote-bridge-v1' }
    }, (err: BusinessError) => {
      if (err) {
        this.onStatus('连接失败，重试中');
        this.scheduleReconnect();
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (ws !== null) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (error) {
          // 连接已坏，交给 close 处理
        }
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat >= 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = -1;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) {
      return;
    }
    if (this.reconnectTimer >= 0) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      if (!this.closedByUser) {
        this.open();
      }
    }, 5000);
  }

  private teardown(): void {
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch (error) {
        // 忽略
      }
    }
  }

  disconnect(): void {
    this.closedByUser = true;
    this.teardown();
  }
}
