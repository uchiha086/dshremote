import { AbilityConstant, ConfigurationConstant, UIAbility, Want, wantAgent } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN = 0x0000;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onWindowStageCreate');

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'dshremote', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'dshremote', 'Succeeded in loading the content.');
    });

    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'dshremote', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onForeground');
    this.stopKeepAlive();
  }

  /** 切到后台时申请长时任务，让轮询在锁屏/后台继续跑，回合结束才有通知。 */
  onBackground(): void {
    hilog.info(DOMAIN, 'dshremote', '%{public}s', 'Ability onBackground');
    this.startKeepAlive();
  }

  private startKeepAlive(): void {
    const info: wantAgent.WantAgentInfo = {
      wants: [{
        bundleName: this.context.abilityInfo.bundleName,
        abilityName: this.context.abilityInfo.name
      }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    wantAgent.getWantAgent(info).then((agent: object) => {
      backgroundTaskManager.startBackgroundRunning(this.context, backgroundTaskManager.BackgroundMode.DATA_TRANSFER, agent)
        .then(() => {
          hilog.info(DOMAIN, 'dshremote', '后台长时任务已开启');
        })
        .catch((err: BusinessError) => {
          hilog.error(DOMAIN, 'dshremote', '后台长时任务开启失败 %{public}d %{public}s', err.code, err.message);
        });
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, 'dshremote', 'wantAgent 获取失败 %{public}d %{public}s', err.code, err.message);
    });
  }

  private stopKeepAlive(): void {
    backgroundTaskManager.stopBackgroundRunning(this.context).then(() => {
      hilog.info(DOMAIN, 'dshremote', '后台长时任务已停止');
    }).catch((err: BusinessError) => {
      hilog.error(DOMAIN, 'dshremote', '后台长时任务停止失败 %{public}d %{public}s', err.code, err.message);
    });
  }
}
