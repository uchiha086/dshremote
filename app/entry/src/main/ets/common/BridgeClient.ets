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

/** /auth/cookie 的返回：登录地址 + 可直接写进 WebView 的 cookie。 */
interface AuthCookieResult {
  ok: boolean;
  url: string;
  cookie: string;
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
  code: string;
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

  /** 向桥要一份可以直接写进 WebView 的登录 cookie。 */
  static async authCookie(baseUrl: string, token: string, targetBase: string): Promise<string> {
    const client = http.createHttp();
    try {
      const url = `${baseUrl}/auth/cookie?token=${encodeURIComponent(token)}&base=${encodeURIComponent(targetBase)}`;
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 8000
      });
      if (response.responseCode !== 200) {
        return '';
      }
      const body = JSON.parse(String(response.result)) as AuthCookieResult;
      return body.ok ? body.cookie : '';
    } catch (error) {
      return '';
    } finally {
      client.destroy();
    }
  }
}

/** /events 的返回。 */
interface EventsResult {
  ok: boolean;
  events: WireFrame[];
}

/** 用 HTTP 轮询 /events 取 turn_end：鸿蒙 WebSocket 发不出帧，改用轮询兜底。 */
export class BridgePoller {
  private timer: number = -1;
  private busy: boolean = false;
  private stopped: boolean = true;
  private baseUrl: string = '';
  private token: string = '';
  private since: number = 0;

  onStatus: (text: string) => void = (text: string) => {
  };
  onTurnEnd: (event: TurnEndEvent) => void = (event: TurnEndEvent) => {
  };

  start(host: string, port: number, token: string): void {
    this.stop();
    this.baseUrl = `http://${host}:${port}`;
    this.token = token;
    // 从此刻开始算，避免把桥里缓存的历史事件全部当新通知重放。
    this.since = Date.now();
    this.stopped = false;
    this.onStatus('轮询已启动');
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, 3000);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) {
      return;
    }
    this.busy = true;
    const client = http.createHttp();
    try {
      const url = `${this.baseUrl}/events?token=${encodeURIComponent(this.token)}&since=${this.since}`;
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 5000,
        readTimeout: 8000
      });
      if (response.responseCode === 200) {
        const body = JSON.parse(String(response.result)) as EventsResult;
        if (body.ok && body.events.length > 0) {
          for (const frame of body.events) {
            if (frame.ts > this.since) {
              this.since = frame.ts;
            }
            if (frame.type !== 'turn_end') {
              continue;
            }
            const event = new TurnEndEvent();
            event.sessionId = frame.sessionId;
            event.sessionTitle = frame.sessionTitle;
            event.question = frame.question;
            event.answerHead = frame.answerHead;
            event.status = frame.status;
            event.turn = frame.turn;
            this.onTurnEnd(event);
          }
          this.onStatus('轮询就绪');
        }
      } else if (response.responseCode === 401) {
        this.onStatus('token 不对');
      }
    } catch (error) {
      // 网络抖动下一轮再试，但把原因显示出来便于排查。
      const err = error as BusinessError;
      this.onStatus(`轮询失败 ${err.code ?? ''} ${err.message ?? ''}`);
    } finally {
      client.destroy();
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }
}

/** 与桥插件的 WebSocket 长连接：负责鉴权、心跳与推送解析。 */
export class BridgeSocket {
  private ws: webSocket.WebSocket | null = null;
  private heartbeat: number = -1;
  private reconnectTimer: number = -1;
  private authTimer: number = -1;
  private authed: boolean = false;
  private wsOpen: boolean = false;
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
    this.wsOpen = false;
    const ws = webSocket.createWebSocket();
    this.ws = ws;

    ws.on('open', () => {
      this.wsOpen = true;
      this.onStatus('WS 已连接');
      this.sendAuth();
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
        this.authed = true;
        this.stopAuthRetry();
        this.onStatus('已连接 · 推送就绪');
        return;
      }
      if (frame.type === 'error') {
        this.onStatus(`桥拒绝：${frame.code}`);
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

    // 不手工塞 Sec-WebSocket-Protocol：ArkWeb 会把它当受限头丢弃，可能导致握手对不上、open 永远不触发。
    ws.connect(`ws://${this.host}:${this.port}/ws`, (err: BusinessError) => {
      if (err) {
        this.onStatus('连接失败，重试中');
        this.scheduleReconnect();
        return;
      }
      // connect 回调早于握手完成，此时直接 send 会被丢弃；用重试循环补发，直到收到 hello 或超时。
      this.startAuthRetry();
    });
  }

  private startAuthRetry(): void {
    this.stopAuthRetry();
    this.authed = false;
    let attempts: number = 0;
    this.authTimer = setInterval(() => {
      if (this.authed || attempts >= 15) {
        this.stopAuthRetry();
        return;
      }
      attempts += 1;
      this.sendAuth();
    }, 600);
    this.sendAuth();
  }

  private stopAuthRetry(): void {
    if (this.authTimer >= 0) {
      clearInterval(this.authTimer);
      this.authTimer = -1;
    }
  }

  private sendAuth(): void {
    const ws = this.ws;
    if (ws === null) {
      return;
    }
    const payload = JSON.stringify({ type: 'auth', token: this.token, deviceName: 'HOP-AL10' });
    try {
      ws.send(payload, (err: BusinessError, ok: boolean) => {
        if (err) {
          this.onStatus(`鉴权发送失败 ${err.code}`);
          return;
        }
        this.startHeartbeat();
      });
    } catch (error) {
      this.onStatus('鉴权发送异常');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (ws !== null) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }), (err: BusinessError) => {
            if (err) {
              this.onStatus('心跳发送失败');
            }
          });
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
    this.stopAuthRetry();
    this.authed = false;
    this.wsOpen = false;
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
