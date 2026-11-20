import { notificationManager } from '@kit.NotificationKit';
import { common, wantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

/** 本地通知：回合结束后在通知栏提醒，点开回到 App。 */
export class Notifier {
  private static ready: boolean = false;
  private static nextId: number = 1;

  /** 申请通知权限；用户拒绝或系统不支持时静默失败，不影响主流程。 */
  static async enable(context: common.UIAbilityContext): Promise<void> {
    try {
      const granted = await notificationManager.isNotificationEnabled();
      if (!granted) {
        await notificationManager.requestEnableNotification(context);
      }
      Notifier.ready = true;
    } catch (error) {
      const err = error as BusinessError;
      console.error(`[dshremote] 通知权限申请失败: ${err.code} ${err.message}`);
      Notifier.ready = false;
    }
  }

  /** 发一条基础文本通知；返回空串表示成功，否则是失败原因（便于界面上直接看）。 */
  static async publish(title: string, text: string): Promise<string> {
    if (!Notifier.ready) {
      return '通知未授权';
    }
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [{
          bundleName: 'com.example.myapplication',
          abilityName: 'EntryAbility'
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };
      const agent = await wantAgent.getWantAgent(info);
      const request: notificationManager.NotificationRequest = {
        id: Notifier.nextId,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: title.length > 0 ? title : 'DSH 回合结束',
            text: text.length > 0 ? text : '点击查看结果',
            additionalText: 'DSH Remote'
          }
        },
        wantAgent: agent
      };
      await notificationManager.publish(request);
      Notifier.nextId += 1;
      return '';
    } catch (error) {
      const err = error as BusinessError;
      console.error(`[dshremote] 通知发送失败: ${err.code} ${err.message}`);
      return `${err.code} ${err.message}`;
    }
  }
}
