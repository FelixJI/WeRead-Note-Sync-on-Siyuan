/**
 * 设置页文案：i18n 键与内置兜底值。
 *
 * - 键为扁平结构（思源内核注入的 plugin.i18n 为 Record<string, string>）。
 * - 内核未注入或键缺失时回落到内置中文，保证界面永不出空串。
 * - public/i18n/zh-CN.json / en.json 提供同名键。
 */
export const SETTINGS_TEXT_FALLBACK = {
    name: "微信读书笔记同步",
    topBarTip: "打开微信读书笔记同步设置",
    commandOpenSetting: "打开设置",
    settingTitle: "微信读书连接",
    settingDescription: "通过微信读书官方 Agent API Gateway 拉取笔记，不发送到任何其他地址。",
    settingApiKeyLabel: "API Key",
    settingApiKeyPlaceholder: "以 wrk- 开头的微信读书 Agent API Key",
    settingApiKeyHint: "仅用于调用微信读书官方 Agent API Gateway（i.weread.qq.com），不会发送到其他任何地址。",
    settingApiKeyShow: "显示",
    settingApiKeyHide: "隐藏",
    settingRememberLabel: "记住 API Key",
    settingStorageNotice:
        "勾选“记住”后，Key 将以明文写入本机 window.localStorage（键名 weread-note-sync.apiKey）：按端本地存储（桌面/浏览器各存各的）、非加密、不随思源内核同步；取消勾选或点击“清除 Key”即删除。未勾选时 Key 仅保存在当前会话内存，重载或禁用插件后即消失。",
    settingTestBtn: "测试连接",
    settingTesting: "测试中…",
    settingClearKeyBtn: "清除 Key",
    settingInvalidKey: "API Key 格式不正确：应以 wrk- 开头、总长度不少于 12 个字符，且不含空格或换行。",
    settingTestOk: "连接成功",
    settingBooksWithNotes: "有笔记书籍",
    settingElapsed: "耗时",
    settingFailKindAuth: "鉴权失败：API Key 无效或已过期，请检查后重试。",
    settingFailKindNetwork: "网络错误：无法访问微信读书网关，请检查本机网络后重试。",
    settingFailKindUpgrade: "微信读书要求升级：请按提示升级后再重试。",
    settingFailKindGateway: "网关错误：微信读书网关返回异常，请稍后重试。",
    settingFailKindInvalidKey: "API Key 无效：应以 wrk- 开头、总长度不少于 12 个字符。",
    settingFailUnexpected: "连接测试出现未预期的错误，请重试。",
    settingKeyCleared: "已清除 API Key（会话内存与本机存储）。",
    settingAccountLabel: "账号标识",
    settingAccountPlaceholder: "例如：我的微信读书主账号",
    settingAccountHint:
        "用于区分不同微信读书账号的笔记身份（参与内容绑定）。请自行命名并记住；更换 API Key 不会自动更换账号，若确实换了账号，请显式修改此标识。",
    settingAccountInvalid: "账号标识包含不支持的字符",
    commandSyncNow: "立即同步",
    commandReviewChanges: "审阅变更",
    syncNeedApiKey: "请先在设置中填写有效的微信读书 API Key。",
    syncNeedAccount: "请先在设置中填写账号标识（区分不同微信读书账号）。",
    syncKeyChangedWarning: "检测到 API Key 与上次不同。若您更换了微信读书账号，请同步修改账号标识；同一账号换新 Key 无需处理。",
    syncRunning: "同步进行中…",
    syncDoneOk: "同步完成。",
    syncDoneWithError: "同步结束（有错误）：",
    syncCreatedCount: "新增",
    syncCandidateCount: "待审变更",
    syncProtectedCount: "受保护项",
    syncBookErrorCount: "出错书籍",
    syncItemErrorCount: "跳过的异常条目",
    syncDeferredCount: "本轮未覆盖书籍（下轮轮转继续）",
    syncSkippedCount: "整书跳过（回包异常或保护模式，详见跳过原因）",
    syncProjectionAnomalyCount: "总览投影告警",
    statsMenuLabel: "阅读统计",
    statsBookTimes: "单书累计时长（近同步前 10 本）",
    statsTitle: "阅读统计",
    statsLoading: "统计加载中…",
    statsRefresh: "刷新",
    statsPrevYear: "上一年",
    statsNextYear: "下一年",
    statsNoDaily: "年度日明细缺失，热力图暂不可用（未伪造数据）",
    statsMonthlyOnly: "仅有月度数据，按契约不绘制日热力图",
    statsUnknownDay: "未知（无日级数据）",
    statsLegend: "图例",
    statsLegendValue: "有阅读（越深越多）",
    statsLegendZero: "零",
    statsLegendUnknown: "未知",
    statsLegendFuture: "未来日期空白",
    syncUnexpectedError: "同步出现未预期的错误，请重试。",
    reviewDialogTitle: "审阅变更",
    reviewClose: "关闭",
    reviewRefresh: "刷新",
    reviewLoading: "正在加载待审条目…",
    reviewLoadError: "加载待审条目失败，请稍后重试。",
    reviewEmpty: "当前没有待审变更。",
    reviewNoMatchFilter: "当前筛选条件下没有条目。",
    reviewFilterAll: "全部",
    reviewFilterBothChanged: "仅冲突（双方已改）",
    reviewFilterRemoteOnly: "仅远端变化",
    reviewKindHighlight: "划线",
    reviewKindReview: "想法",
    reviewConflictIdentical: "内容一致",
    reviewConflictRemoteOnly: "仅远端变化",
    reviewConflictLocalOnly: "仅本地变化",
    reviewConflictBothChanged: "双方已改",
    reviewBaselineLabel: "基线（上次同步）",
    reviewBaselineToggleShow: "展开",
    reviewBaselineToggleHide: "收起",
    reviewLocalLabel: "本地现状",
    reviewRemoteLabel: "远端版本",
    reviewDiffHint: "标记说明：“+” 加实线下划线 = 远端新增；“-” 加删除线 = 本地独有（颜色仅辅助辨认）。",
    reviewDiffInsLabel: "远端新增",
    reviewDiffDelLabel: "本地独有",
    reviewDetectedAt: "发现时间",
    reviewLocateBlock: "定位原块",
    reviewActionApplyRemote: "采用远端",
    reviewActionKeepLocal: "保留本地",
    reviewActionManualMerge: "手动合并",
    reviewActionSaveCopy: "另存副本",
    reviewActionDefer: "稍后处理",
    reviewManualMergeHint: "编辑合并后的正文（已预填远端文本）；确认后将按受控更新协议写入原文档块。",
    reviewManualConfirm: "确认合并",
    reviewManualCancel: "取消",
    reviewBusy: "处理中…",
    reviewStaleNotice: "内容已发生变化，已重新加载 diff（未自动应用），请重新审阅。",
    reviewApplyFailedPrefix: "操作失败：",
    reviewDeferredGroup: "稍后处理",
    reviewRestoreDeferred: "恢复审阅",
    reviewDeferredHint: "稍后处理的条目状态未改动也不会丢失，刷新或重新打开审阅后会重新出现。",
} as const;

export type SettingsTextKey = keyof typeof SETTINGS_TEXT_FALLBACK;

export type SettingsText = Readonly<Record<SettingsTextKey, string>>;

export function createSettingsText(i18n: Record<string, string>): SettingsText {
    const text: Record<SettingsTextKey, string> = { ...SETTINGS_TEXT_FALLBACK };
    for (const key of Object.keys(SETTINGS_TEXT_FALLBACK) as SettingsTextKey[]) {
        const value = i18n[key];
        if (typeof value === "string" && value.length > 0) {
            text[key] = value;
        }
    }
    return text;
}
