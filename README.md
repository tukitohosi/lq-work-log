# L.Q记工本

简体中文 | [English](README.en.md)

**离线记工，算清每个人的出勤与工资。**

记录上午、下午和加班，管理请假、工地、补贴扣款与结清状态，查看月度和年度统计，并导出 Excel、PDF 或完整备份。

当前版本：**Windows 2.2.1 · Android 2.2.2**。[Windows 下载](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.1) · [Android 下载](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.2-android) · [使用指南](项目介绍与使用指南.md)

## 主要功能

- 按工人记录出勤、加班和带薪／无薪请假，可单人添加或批量录入。
- 桌面端支持点击、拖动、圈选、键盘记工和最多 50 步撤销。
- 手机端提供整月七列月历、当日自动保存、批量记工和当日工人卡片。
- 按生效月份保存日薪历史，过去月份的工资不随当前日薪变化。
- 按工地查看每日人员、月度／年度成本，记录补贴、扣款和工资结清。
- 导出 Excel 与打印／PDF 报表，使用完整 JSON 备份或迁移数据。
- 提供内部备份；Windows 另支持每周保存到“文档”中的外部备份目录。

## 下载与开始使用

| 平台 | 下载文件 | 说明 |
| --- | --- | --- |
| Windows x64 | LQ-Work-Log-2.2.1-Setup.exe | 自带运行环境，无需另装 Node.js |
| Android 7.0+ | LQ-Work-Log-2.2.2-Android.apk | 直接安装 APK；升级时覆盖安装 |

Android 包使用正式签名；AAB 用于应用商店上传，不能直接点击安装。

添加工人及日薪后，在月历中记工。打开当日详情可调整备注、请假和工地，再到工地统计或年度汇总查看结果。

## 数据与使用限制

- 应用离线运行，数据保存在本机，没有在线账号或自动跨设备同步。
- 完整 JSON 可在设备间备份和迁移；Excel、PDF 是报表，不能恢复数据。
- Android 卸载会删除应用私有目录中的数据。升级前导出 JSON，并直接覆盖安装。
- Windows 数据位于当前用户的 AppData/Roaming/L.Q记工本/data，正常卸载保留数据；每周外部备份默认保留最近 12 份。
- 被历史出勤引用的工人和工地采用归档方式，历史记录仍可查看。
- 单份应用数据上限为 64 MiB。

## 常用快捷键（Windows）

| 快捷键 | 操作 |
| --- | --- |
| Ctrl+N | 添加工人 |
| Ctrl+F | 搜索 |
| Ctrl+Z | 撤销 |
| Ctrl+T 或 Alt+T | 回到今天 |
| Ctrl+← / Ctrl+→ | 切换月份 |
| 方向键 | 移动考勤格 |
| 1 / 2 | 上午或下午出工／休息 |
| 3 / 4 | 加班半工／一工 |
| Backspace | 清空当前可编辑格 |

## 开发

Windows 源码需要 Node.js 22.12 或更新版本。

~~~powershell
npm ci
npm run build
npm run desktop:start
~~~

Android 源码及构建要求见 [android-app](android-app/README.md)。
