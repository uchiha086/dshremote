import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { webview } from '@kit.ArkWeb';
import { BridgeConfig, ConfigStore } from '../common/ConfigStore';
import { BridgeHttp, BridgePoller, TurnEndEvent } from '../common/BridgeClient';
import { Discovery, FoundHost } from '../common/Discovery';
import { Notifier } from '../common/Notifier';
import { applyPairing, parsePairing, PairResult } from '../common/Pairing';

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
  @State foundName: string = '';
  @State hasFound: boolean = false;
  @StorageLink('pairUri') @Watch('onPairUriChanged') pairUri: string = '';

  private found: FoundHost = new FoundHost();
  private discovery: Discovery = new Discovery();
  private controller: webview.WebviewController = new webview.WebviewController();
  private cfg: BridgeConfig = new BridgeConfig();
  private poller: BridgePoller = new BridgePoller();

  aboutToAppear(): void {
    const context = getContext(this) as common.UIAbilityContext;
    Notifier.enable(context);
    this.discovery.onFound = (host: FoundHost) => {
      this.found = host;
      this.foundName = host.name;
      this.hasFound = true;
      this.testResult = `发现电脑：${host.name}，点「连接」即可`;
    };
    this.discovery.onError = (message: string) => {
      this.foundName = message;
    };
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
        this.discovery.start();
      }
    });
  }

  aboutToDisappear(): void {
    this.poller.stop();
    this.discovery.stop();
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

  /** 系统相机扫到的配对链接会通过 AppStorage 送进来。 */
  onPairUriChanged(): void {
    if (this.pairUri.length === 0) {
      return;
    }
    const text = this.pairUri;
    this.pairUri = '';
    AppStorage.setOrCreate<string>('pairUri', '');
    this.applyPairText(text);
  }

  private applyPairText(raw: string): void {
    const result: PairResult = parsePairing(raw);
    if (!result.ok) {
      this.testResult = result.error;
      return;
    }
    const cfg = this.readForm();
    applyPairing(cfg, result);
    this.cfg = cfg;
    this.hostInput = cfg.host;
    this.portInput = `${cfg.port}`;
    this.tokenInput = cfg.token;
    this.tunnelInput = cfg.tunnel;
    this.testResult = `已配对：${result.name}`;
    this.saveAndEnter();
  }

  private async scanPair(): Promise<void> {
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.ALL],
        enableMultiMode: false,
        enableAlbum: true,
      };
      const context = getContext(this) as common.UIAbilityContext;
      const result = await scanBarcode.startScanForResult(context, options);
      const text = result.originalValue ?? '';
      if (text.length > 0) {
        this.applyPairText(text);
      }
    } catch (error) {
      this.testResult = '扫码取消或失败';
    }
  }

  private async connectFound(): Promise<void> {
    const cfg = this.readForm();
    cfg.host = this.found.base.replace('http://', '').split(':')[0];
    const basePort = Number(this.found.base.split(':').pop());
    cfg.port = Number.isFinite(basePort) && basePort > 0 ? basePort : 3088;
    const webPort = Number(this.found.web.split(':').pop());
    cfg.proxyPort = Number.isFinite(webPort) && webPort > 0 ? webPort : 7627;
    cfg.token = this.found.token;
    cfg.tunnel = '';
    this.cfg = cfg;
    this.hostInput = cfg.host;
    this.portInput = `${cfg.port}`;
    this.tokenInput = cfg.token;
    this.tunnelInput = '';
    this.testResult = `连接 ${this.found.name}…`;
    await this.saveAndEnter();
  }

  private async enterMain(): Promise<void> {
    const lanBase = this.cfg.webUrl();
    this.webReady = false;
    this.discovery.stop();
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
      Text('先在电脑上装好 dshremote-bridge 插件，用「扫一扫」或「自动发现」配对，也可以手动填')
        .fontSize(13)
        .fontColor('#666666')
        .textAlign(TextAlign.Center)
        .padding({ left: 24, right: 24 })

      Row({ space: 12 }) {
        Button('扫一扫配对')
          .enabled(!this.busy)
          .onClick(() => {
            this.scanPair();
          })
        Button(this.hasFound ? `连接 ${this.foundName}` : '自动发现')
          .enabled(!this.busy)
          .onClick(() => {
            if (this.hasFound) {
              this.connectFound();
            } else {
              this.testResult = '正在搜索同一 Wi-Fi 下的电脑…';
              this.discovery.start();
            }
          })
      }

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
            this.discovery.start();
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
