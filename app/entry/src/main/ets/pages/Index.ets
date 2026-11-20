import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { BridgeConfig, ConfigStore } from '../common/ConfigStore';
import { BridgeHttp, BridgePoller, ClaimResult, TurnEndEvent } from '../common/BridgeClient';
import { Discovery, FoundHost } from '../common/Discovery';
import { Notifier } from '../common/Notifier';
import { applyPairing, parsePairing, PairResult } from '../common/Pairing';

/**
 * 三段式界面：
 *   scan     —— 没配对过：只放一个「扫码连接电脑」和备用入口
 *   main     —— 已配对：全屏 DSH，右上角只有一枚设置按钮
 *   settings —— 手动改地址 / 重新扫码 / 看连接测试结果
 * 连接状态、隧道、令牌这些细节都不在主界面出现，出错才回到设置页显示原因。
 */
@Entry
@Component
struct Index {
  @State stage: string = 'loading';
  @State hostInput: string = '';
  @State portInput: string = '3088';
  @State tokenInput: string = '';
  @State tunnelInput: string = '';
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
      this.testResult = `发现电脑：${host.name}`;
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
      // 冷启动时系统相机把 dshremote:// 链接直接交给本应用：@Watch 不会触发，得在这里主动消费。
      const pending = AppStorage.get<string>('pairUri') ?? '';
      if (pending.length > 0) {
        AppStorage.setOrCreate<string>('pairUri', '');
        this.pairUri = '';
        // 冷启动也不能跳过确认：任何网页/应用都能发 dshremote:// 链接。
        this.confirmPair(pending, () => {
          this.stage = loaded.valid() ? 'main' : 'scan';
          if (loaded.valid()) {
            this.enterMain();
          }
        });
        return;
      }
      if (loaded.valid()) {
        this.stage = 'main';
        await this.enterMain();
      } else {
        this.stage = 'scan';
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

  /** 设置页里的「测试连接」。 */
  private async testConnection(): Promise<void> {
    this.busy = true;
    const cfg = this.readForm();
    this.cfg = cfg;
    await this.pickTransport();
    this.testResult = await BridgeHttp.health(this.cfg.baseUrl());
    this.busy = false;
  }

  /** 设置页里的「保存并进入」。 */
  private async saveAndEnter(): Promise<void> {
    const cfg = this.readForm();
    if (!cfg.valid()) {
      this.testResult = '地址和令牌都要填，扫码通常会自动填好';
      return;
    }
    this.busy = true;
    this.cfg = cfg;
    await this.pickTransport();
    const health = await BridgeHttp.health(this.cfg.baseUrl());
    hilog.info(0x0000, 'dshremote', '保存并进入 base=%{public}s health=%{public}s', this.cfg.baseUrl(), health);
    if (!health.startsWith('桥')) {
      this.testResult = health;
      this.busy = false;
      this.stage = 'settings';
      return;
    }
    await ConfigStore.save(this.cfg);
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
    this.confirmPair(text, () => { });
  }

  /** 外来的深链不能直接连：先让用户看一眼是不是自己的电脑。取消时走 onCancel。 */
  private confirmPair(text: string, onCancel: () => void): void {
    const preview: PairResult = parsePairing(text);
    AlertDialog.show({
      title: '收到配对请求',
      message: preview.ok
        ? `来自「${preview.name}」的配对链接，确认连接这台电脑吗？`
        : `这个链接不是 DSH Remote 的配对码：${preview.error}`,
      primaryButton: {
        value: '取消',
        action: () => {
          onCancel();
        }
      },
      secondaryButton: {
        value: '连接',
        action: () => {
          this.applyPairText(text);
        }
      }
    });
  }

  private async applyPairText(raw: string): Promise<void> {
    const result: PairResult = parsePairing(raw);
    if (!result.ok) {
      this.testResult = result.error;
      this.stage = 'scan';
      return;
    }
    const cfg = this.readForm();
    applyPairing(cfg, result);
    // v2：二维码里只有 60 秒一次性码，先换真 token 才能连。
    if (result.needsClaim) {
      this.testResult = '正在用一次性码换取访问凭证…';
      const lanBase = result.host.length > 0 ? `http://${result.host}:${result.port}` : '';
      const candidates: string[] = lanBase.length > 0 ? [lanBase] : [];
      if (result.tunnel.length > 0) {
        candidates.push(result.tunnel);
      }
      let claimed: ClaimResult | null = null;
      for (const candidateBase of candidates) {
        claimed = await BridgeHttp.claim(candidateBase, result.code);
        if (claimed !== null) {
          break;
        }
      }
      if (claimed === null) {
        this.testResult = '配对码已失效（一次性码 60 秒过期），请回电脑刷新二维码';
        this.stage = 'scan';
        return;
      }
      cfg.token = claimed.token;
      if (claimed.tunnel.length > 0) {
        cfg.tunnel = claimed.tunnel;
      }
    }
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
    cfg.tunnel = this.found.publicUrl.length > 0 ? this.found.publicUrl : '';
    this.cfg = cfg;
    this.hostInput = cfg.host;
    this.portInput = `${cfg.port}`;
    this.tokenInput = cfg.token;
    this.tunnelInput = cfg.tunnel;
    this.discovery.stop();
    await this.saveAndEnter();
  }

  /**
   * 同时存着局域网和公网地址时，先花 2 秒试一下局域网：
   * 通了就直连（快、不绕公网），不通就自动改走隧道（换个网络也不用重新扫码）。
   */
  private async pickTransport(): Promise<void> {
    if (this.cfg.host.length === 0) {
      return;
    }
    const probe = await BridgeHttp.health(this.cfg.lanBase(), 2000);
    const lanAlive = probe.startsWith('桥 ');
    if (lanAlive) {
      const tunnel = await BridgeHttp.pairInfo(this.cfg.lanBase());
      if (tunnel.length > 0 && tunnel !== this.cfg.tunnel) {
        this.cfg.tunnel = tunnel;
        this.tunnelInput = tunnel;
      }
      this.cfg.preferTunnel = false;
    } else if (this.cfg.tunnelUrl().length > 0) {
      this.cfg.preferTunnel = true;
    }
    await ConfigStore.save(this.cfg);
  }

  private async enterMain(): Promise<void> {
    await this.pickTransport();
    const base = this.cfg.webUrl();
    this.webReady = false;
    this.discovery.stop();
    this.poller.onStatus = () => {
      // 主界面不展示连接细节，状态只留在内部。
    };
    this.poller.onTurnEnd = (event: TurnEndEvent) => {
      const title = event.sessionTitle.length > 0 ? event.sessionTitle : 'DSH';
      const head = event.answerHead.length > 0 ? event.answerHead : event.question;
      Notifier.publish(`${title} · ${event.status}`, head);
    };
    this.poller.start(this.cfg.baseUrl(), this.cfg.token);
    const tunnel = this.cfg.tunnelUrl();
    if (tunnel.length > 0) {
      const authority = tunnel.replace('https://', '').replace('http://', '').split('/')[0];
      await BridgeHttp.trust(this.cfg.baseUrl(), this.cfg.token, authority);
    }
    const cookie = await BridgeHttp.authCookie(this.cfg.baseUrl(), this.cfg.token, base);
    if (cookie.length > 0) {
      try {
        webview.WebCookieManager.configCookieSync(base, cookie);
      } catch (error) {
        hilog.error(0x0000, 'dshremote', '写 cookie 失败');
      }
    }
    this.webUrl = base;
    this.webReady = true;
  }

  private openSettings(): void {
    this.stage = 'settings';
  }

  private closeSettings(): void {
    this.testResult = '';
    this.stage = this.cfg.valid() ? 'main' : 'scan';
    if (this.stage === 'scan') {
      this.discovery.start();
    }
  }

  build() {
    Stack() {
      if (this.stage === 'main') {
        this.mainView()
      } else if (this.stage === 'settings') {
        this.settingsView()
      } else if (this.stage === 'scan') {
        this.scanView()
      } else {
        this.loadingView()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }

  @Builder
  loadingView() {
    Column({ space: 12 }) {
      LoadingProgress().width(48).height(48)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  scanView() {
    Column({ space: 18 }) {
      Blank().layoutWeight(1)
      Text('DSH Remote').fontSize(30).fontWeight(FontWeight.Bold)
      Text('用手机操控电脑上的 DeepSeek Harness')
        .fontSize(14)
        .fontColor('#666666')
      Blank().height(12)
      Button('扫码连接电脑')
        .width(220)
        .height(48)
        .fontSize(16)
        .onClick(() => {
          this.scanPair();
        })
      if (this.hasFound) {
        Button(`连接 ${this.foundName}`)
          .width(220)
          .height(42)
          .fontSize(14)
          .backgroundColor('#EEF2FF')
          .fontColor('#1D4ED8')
          .onClick(() => {
            this.connectFound();
          })
      } else {
        Button('自动发现电脑')
          .width(220)
          .height(42)
          .fontSize(14)
          .backgroundColor('#F3F4F6')
          .fontColor('#374151')
          .onClick(() => {
            this.testResult = '';
            this.discovery.start();
          })
      }
      if (this.testResult.length > 0) {
        Text(this.testResult)
          .fontSize(12)
          .fontColor('#B91C1C')
          .textAlign(TextAlign.Center)
          .padding({ left: 32, right: 32 })
      }
      Button('手动设置地址')
        .backgroundColor(Color.Transparent)
        .fontColor('#6B7280')
        .fontSize(13)
        .onClick(() => {
          this.stage = 'settings';
        })
      Blank().layoutWeight(1)
      Text('在同一 Wi-Fi 或电脑已开隧道时可用')
        .fontSize(11)
        .fontColor('#9CA3AF')
        .margin({ bottom: 24 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  mainView() {
    Stack({ alignContent: Alignment.TopEnd }) {
      if (this.webReady) {
        Web({ src: this.webUrl, controller: this.controller })
          .domStorageAccess(true)
          .fileAccess(false)
          .darkMode(WebDarkMode.Auto)
          .width('100%')
          .height('100%')
      } else {
        Column({ space: 10 }) {
          LoadingProgress().width(40).height(40)
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }
      Button() {
        SymbolGlyph($r('sys.symbol.gearshape'))
          .fontSize(18)
          .fontColor(['#4B5563'])
      }
      .width(34)
      .height(34)
      .backgroundColor('#F2FFFFFF')
      .borderRadius(17)
      .border({ width: 1, color: '#1F000000' })
      .margin({ top: 46, right: 10 })
      .onClick(() => {
        this.openSettings();
      })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  settingsView() {
    Column() {
      Row({ space: 8 }) {
        Button('返回')
          .fontSize(14)
          .backgroundColor(Color.Transparent)
          .fontColor('#2563EB')
          .onClick(() => {
            this.closeSettings();
          })
        Blank()
        Text('设置').fontSize(17).fontWeight(FontWeight.Medium)
        Blank()
        Button('').width(48).backgroundColor(Color.Transparent)
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 8 })

      Scroll() {
        Column({ space: 12 }) {
          Button('扫码重新配对')
            .width('100%')
            .height(44)
            .onClick(() => {
              this.scanPair();
            })

          TextInput({ text: this.hostInput, placeholder: '电脑 IP 或主机名' })
            .height(44)
            .onChange((value: string) => {
              this.hostInput = value;
            })
          TextInput({ text: this.portInput, placeholder: '端口 3088' })
            .height(44)
            .type(InputType.Number)
            .onChange((value: string) => {
              this.portInput = value;
            })
          TextInput({ text: this.tokenInput, placeholder: '配对令牌' })
            .height(44)
            .onChange((value: string) => {
              this.tokenInput = value;
            })
          TextInput({ text: this.tunnelInput, placeholder: '隧道地址（可选，https://…）' })
            .height(44)
            .onChange((value: string) => {
              this.tunnelInput = value;
            })

          Row({ space: 10 }) {
            Button('测试连接')
              .layoutWeight(1)
              .height(44)
              .enabled(!this.busy)
              .backgroundColor('#F3F4F6')
              .fontColor('#111827')
              .onClick(() => {
                this.testConnection();
              })
            Button('保存并进入')
              .layoutWeight(1)
              .height(44)
              .enabled(!this.busy)
              .onClick(() => {
                this.saveAndEnter();
              })
          }

          if (this.testResult.length > 0) {
            Text(this.testResult)
              .fontSize(12)
              .fontColor(this.testResult.startsWith('桥 ') ? '#15803D' : '#B91C1C')
              .width('100%')
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 8, bottom: 20 })
      }
      .layoutWeight(1)

      Text('v0.2.1 · 电脑端需要 dshremote-bridge 插件')
        .fontSize(11)
        .fontColor('#9CA3AF')
        .margin({ bottom: 18 })
    }
    .width('100%')
    .height('100%')
  }
}
