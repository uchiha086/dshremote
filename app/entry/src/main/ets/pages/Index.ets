import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BridgeConfig, ConfigStore } from '../common/ConfigStore';
import { BridgeHttp, BridgePoller, TurnEndEvent } from '../common/BridgeClient';
import { Notifier } from '../common/Notifier';

@Entry
@Component
struct Index {
  @State stage: string = 'loading';
  @State hostInput: string = '';
  @State portInput: string = '3088';
  @State tokenInput: string = '';
  @State tunnelInput: string = '';
  @State statusText: string = '未连接';
  @State testResult: string = '';
  @State busy: boolean = false;
  @State webUrl: string = '';
  @State webReady: boolean = false;

  private controller: webview.WebviewController = new webview.WebviewController();
  private cfg: BridgeConfig = new BridgeConfig();
  private poller: BridgePoller = new BridgePoller();

  aboutToAppear(): void {
    const context = getContext(this) as common.UIAbilityContext;
    Notifier.enable(context);
    ConfigStore.init(context).then(async () => {
      const loaded = await ConfigStore.load();
      this.cfg = loaded;
      this.hostInput = loaded.host;
      this.portInput = `${loaded.port}`;
      this.tokenInput = loaded.token;
      this.tunnelInput = loaded.tunnel;
      if (loaded.valid()) {
        this.stage = 'main';
        await this.enterMain();
      } else {
        this.stage = 'setup';
      }
    });
  }

  aboutToDisappear(): void {
    this.poller.stop();
  }

  private readForm(): BridgeConfig {
    const cfg = new BridgeConfig();
    cfg.host = this.hostInput.trim();
    cfg.port = Number(this.portInput.trim());
    if (!Number.isFinite(cfg.port) || cfg.port <= 0) {
      cfg.port = 3088;
    }
    cfg.token = this.tokenInput.trim();
    cfg.proxyPort = 7627;
    cfg.tunnel = this.tunnelInput.trim();
    return cfg;
  }

  private async testConnection(): Promise<void> {
    this.busy = true;
    const cfg = this.readForm();
    this.testResult = await BridgeHttp.health(cfg.baseUrl());
    this.busy = false;
  }

  private async saveAndEnter(): Promise<void> {
    const cfg = this.readForm();
    if (!cfg.valid()) {
      this.testResult = 'IP、端口、token 都要填';
      return;
    }
    this.busy = true;
    const health = await BridgeHttp.health(cfg.baseUrl());
    if (!health.startsWith('桥')) {
      this.testResult = health;
      this.busy = false;
      return;
    }
    this.cfg = cfg;
    await ConfigStore.save(cfg);
    this.busy = false;
    this.stage = 'main';
    await this.enterMain();
  }

  private async enterMain(): Promise<void> {
    const lanBase = this.cfg.webUrl();
    this.webReady = false;
    this.poller.onStatus = (text: string) => {
      this.statusText = text;
    };
    this.poller.onTurnEnd = (event: TurnEndEvent) => {
      const title = event.sessionTitle.length > 0 ? event.sessionTitle : '会话';
      this.statusText = `回合结束 · ${title}`;
      const head = event.answerHead.length > 0 ? event.answerHead : event.question;
      Notifier.publish(`${title} · ${event.status}`, head).then((reason: string) => {
        if (reason.length > 0) {
          this.statusText = `回合结束 · 通知失败：${reason}`;
        }
      });
    };
    this.poller.start(this.cfg.baseUrl(), this.cfg.token);
    // 走隧道时先把公网域名登记进 DSH 的 trustedHosts，否则页面里的 /api 会 403。
    const tunnel = this.cfg.tunnelUrl();
    if (tunnel.length > 0) {
      const authority = tunnel.replace('https://', '').replace('http://', '').split('/')[0];
      await BridgeHttp.trust(this.cfg.baseUrl(), this.cfg.token, authority);
    }
    // 让桥代取一次登录 cookie，再自己写进 WebView：避开 WebView 对 SameSite=Strict cookie 的拦截。
    const cookie = await BridgeHttp.authCookie(this.cfg.baseUrl(), this.cfg.token, lanBase);
    if (cookie.length > 0) {
      try {
        webview.WebCookieManager.configCookieSync(lanBase, cookie);
      } catch (error) {
        this.statusText = '写登录 cookie 失败';
      }
    }
    this.statusText = cookie.length > 0 ? '正在打开 DSH…' : '未取得登录 cookie';
    // cookie 写好之后再挂 Web 组件，避免先加载出 401 页面。
    this.webUrl = lanBase;
    this.webReady = true;
  }

  @Builder
  setupView() {
    Column({ space: 14 }) {
      Text('连接你的电脑').fontSize(26).fontWeight(FontWeight.Bold)
      Text('先在电脑上装好 dshremote-bridge 插件，把它的 token 填进来')
        .fontSize(13)
        .fontColor('#666666')
        .textAlign(TextAlign.Center)
        .padding({ left: 24, right: 24 })

      TextInput({ placeholder: '电脑 IP，例如 192.168.68.225', text: this.hostInput })
        .onChange((value: string) => {
          this.hostInput = value;
        })
        .width('100%')

      TextInput({ placeholder: '端口，默认 3088', text: this.portInput })
        .type(InputType.Number)
        .onChange((value: string) => {
          this.portInput = value;
        })
        .width('100%')

      TextInput({ placeholder: '配对 token', text: this.tokenInput })
        .onChange((value: string) => {
          this.tokenInput = value;
        })
        .width('100%')

      TextInput({ placeholder: '隧道地址（可选，https://xxx.trycloudflare.com）', text: this.tunnelInput })
        .onChange((value: string) => {
          this.tunnelInput = value;
        })
        .width('100%')

      Row({ space: 12 }) {
        Button('测试连接')
          .enabled(!this.busy)
          .onClick(() => {
            this.testConnection();
          })
        Button('保存并进入')
          .enabled(!this.busy)
          .onClick(() => {
            this.saveAndEnter();
          })
      }

      if (this.testResult.length > 0) {
        Text(this.testResult).fontSize(13).fontColor('#0a7').textAlign(TextAlign.Center)
      }

      Text('v0.1.0 · 需要电脑端 dshremote-bridge 插件')
        .fontSize(11)
        .fontColor('#999999')
        .margin({ top: 8 })
    }
    .padding({ left: 24, right: 24 })
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  mainView() {
    Column() {
      Row({ space: 8 }) {
        Text(this.statusText).fontSize(13).fontColor('#666666').layoutWeight(1)
        Button('刷新')
          .buttonStyle(ButtonStyleMode.TEXTUAL)
          .onClick(() => {
            this.controller.refresh();
          })
        Button('设置')
          .buttonStyle(ButtonStyleMode.TEXTUAL)
          .onClick(() => {
            this.poller.stop();
            this.statusText = '已断开';
            this.stage = 'setup';
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 4, bottom: 4 })

      if (this.webReady) {
        Web({ src: this.webUrl, controller: this.controller })
          .domStorageAccess(true)
          .fileAccess(false)
          .width('100%')
          .layoutWeight(1)
          .onPageEnd(() => {
            this.statusText = 'DSH 已加载 · 等待回合结束';
          })
      } else {
        Column({ space: 10 }) {
          LoadingProgress().width(48).height(48)
          Text(this.statusText).fontSize(13).fontColor('#888888')
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      if (this.stage === 'main') {
        this.mainView()
      } else if (this.stage === 'setup') {
        this.setupView()
      } else {
        Text('正在读取配置…').fontSize(14).fontColor('#888888')
      }
    }
    .width('100%')
    .height('100%')
  }
}
