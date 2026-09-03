// ============================================================
// JLPT N2 多维语境词库
// 5 大领域，每领域 4-6 个场景，每场景含 4 维要素
// ============================================================

export interface VocabScenario {
  /** 唯一标识 */
  id: string
  /** 所属领域 */
  domain: string
  /** 领域中文名 */
  domainZh: string
  /** 场景中文标题 */
  titleZh: string
  /** 场景日文标题 */
  titleJa: string
  /** 地点与环境 */
  settingZh: string
  /** 对方角色 */
  partnerZh: string
  /** 核心交流挑战 */
  challengeZh: string
  /** 2-3 个必备 N2 表达 */
  keyExpressions: string[]
}

export const DOMAINS = [
  { id: 'daily', label: '日常消费与服务' },
  { id: 'work', label: '职场协作与商务' },
  { id: 'emergency', label: '突发故障与求助' },
  { id: 'social', label: '社交与日常闲聊' },
  { id: 'admin', label: '生活手续与契约' },
] as const

export const VOCAB_BANK: VocabScenario[] = [
  // ──── 日常消费与服务 ────
  {
    id: 'daily-conbini',
    domain: 'daily',
    domainZh: '日常消费与服务',
    titleZh: '便利店询问',
    titleJa: 'コンビニでの問い合わせ',
    settingZh: '日本便利店（ローソン/セブン）',
    partnerZh: '礼貌但语速较快的店员',
    challengeZh: '用日语询问特定商品位置并确认支付方式',
    keyExpressions: ['〜はどこにありますか', '〜でお願いします', '袋は大丈夫です'],
  },
  {
    id: 'daily-salon',
    domain: 'daily',
    domainZh: '日常消费与服务',
    titleZh: '美发沙龙',
    titleJa: '美容室でのオーダー',
    settingZh: '日本美发沙龙（美容室）',
    partnerZh: '亲切健谈的发型师',
    challengeZh: '说明修剪长度并委婉提出打薄要求',
    keyExpressions: ['短めにしてください', '髪をすいてほしい', 'セットしやすいように'],
  },
  {
    id: 'daily-cafe',
    domain: 'daily',
    domainZh: '日常消费与服务',
    titleZh: '咖啡定制',
    titleJa: 'カフェでのカスタムオーダー',
    settingZh: '小型独立咖啡馆',
    partnerZh: '咖啡爱好者店主',
    challengeZh: '描述口味偏好并询问推荐',
    keyExpressions: ['甘さ控えめで', 'おすすめはありますか', 'テイクアウトで'],
  },
  {
    id: 'daily-izakaya',
    domain: 'daily',
    domainZh: '日常消费与服务',
    titleZh: '居酒屋点单',
    titleJa: '居酒屋での注文',
    settingZh: '同事聚会的居酒屋',
    partnerZh: '热情的居酒屋服务员',
    challengeZh: '为团体点单并处理过敏/忌口说明',
    keyExpressions: ['〜は抜きでお願いします', 'とりあえず生で', '〜のアレルギーがあります'],
  },
  {
    id: 'daily-return',
    domain: 'daily',
    domainZh: '日常消费与服务',
    titleZh: '退换货',
    titleJa: '返品・交換の手続き',
    settingZh: '电器卖场（ヨドバシ/ビックカメラ）',
    partnerZh: '严格但专业的客服人员',
    challengeZh: '说明退货原因并出示收据',
    keyExpressions: ['サイズが合わなかった', 'レシートはこちらです', '交換は可能ですか'],
  },

  // ──── 职场协作与商务 ────
  {
    id: 'work-leave',
    domain: 'work',
    domainZh: '职场协作与商务',
    titleZh: '请假报备',
    titleJa: '休暇の申請',
    settingZh: '办公室，向直属上司请假',
    partnerZh: '理解但注重流程的上司',
    challengeZh: '用敬语说明请假理由并确认交接',
    keyExpressions: ['お休みをいただきたい', '引き継ぎは〜にお願いしてあります', 'ご迷惑をおかけしますが'],
  },
  {
    id: 'work-progress',
    domain: 'work',
    domainZh: '职场协作与商务',
    titleZh: '进度汇报',
    titleJa: '進捗報告',
    settingZh: '周例会议上向团队汇报',
    partnerZh: '关注细节的项目经理',
    challengeZh: '简洁汇报当前进度并提出延期风险',
    keyExpressions: ['予定通り進んでいます', '若干遅れが出ていまして', '来週中に完了する見込みです'],
  },
  {
    id: 'work-nudge',
    domain: 'work',
    domainZh: '职场协作与商务',
    titleZh: '委婉催促',
    titleJa: 'やんわりとした催促',
    settingZh: '办公室走廊偶遇同事',
    partnerZh: '拖延但好脾气的同事',
    challengeZh: '不伤感情地催促迟交的资料',
    keyExpressions: ['あの件、その後いかがでしょうか', '急かすようで申し訳ないですが', 'いつ頃いただけそうですか'],
  },
  {
    id: 'work-feedback',
    domain: 'work',
    domainZh: '职场协作与商务',
    titleZh: '意见反馈',
    titleJa: 'フィードバック',
    settingZh: '一对一面谈',
    partnerZh: '开放态度的团队领导',
    challengeZh: '提出改善建议而不显得挑剔',
    keyExpressions: ['一つ提案があるのですが', '〜した方がより良いかと', '個人的な意見ですが'],
  },

  // ──── 突发故障与求助 ────
  {
    id: 'emergency-train',
    domain: 'emergency',
    domainZh: '突发故障与求助',
    titleZh: '电车延误',
    titleJa: '電車の遅延対応',
    settingZh: '早高峰东京某 JR 车站',
    partnerZh: '忙碌但尽职的站务员',
    challengeZh: '询问替代路线并索取延误证明',
    keyExpressions: ['振替輸送はありますか', '遅延証明をいただけますか', '〜駅までの別ルートは'],
  },
  {
    id: 'emergency-lost',
    domain: 'emergency',
    domainZh: '突发故障与求助',
    titleZh: '丢东西挂失',
    titleJa: '遺失物届の提出',
    settingZh: '最近的交番（派出所）',
    partnerZh: '耐心的值班警察',
    challengeZh: '描述遗失物品特征和丢失地点',
    keyExpressions: ['〜を落としたようです', '特徴は〜です', '見つかったら連絡いただけますか'],
  },
  {
    id: 'emergency-sick',
    domain: 'emergency',
    domainZh: '突发故障与求助',
    titleZh: '身体不适就医',
    titleJa: '病院での受診',
    settingZh: '内科诊所受付',
    partnerZh: '温和的护士和医生',
    challengeZh: '描述症状并回答医生追问',
    keyExpressions: ['昨日から〜が痛いです', '熱があります', '薬のアレルギーはありません'],
  },
  {
    id: 'emergency-repair',
    domain: 'emergency',
    domainZh: '突发故障与求助',
    titleZh: '网络报修',
    titleJa: 'ネット回線の修理依頼',
    settingZh: '电话联系网络运营商客服',
    partnerZh: '按脚本引导的客服人员',
    challengeZh: '描述故障现象并配合远程排查指示',
    keyExpressions: ['インターネットが繋がらなくて', 'ルーターの再起動は試しました', 'いつ頃復旧しますか'],
  },

  // ──── 社交与日常闲聊 ────
  {
    id: 'social-weekend',
    domain: 'social',
    domainZh: '社交与日常闲聊',
    titleZh: '周末近况',
    titleJa: '週末の過ごし方',
    settingZh: '公司休息室午休时间',
    partnerZh: '关系普通但友好的日本同事',
    challengeZh: '自然地描述周末活动并反问对方',
    keyExpressions: ['〜に行ってきました', '〜が印象的でした', '〜さんは何をされましたか'],
  },
  {
    id: 'social-hobby',
    domain: 'social',
    domainZh: '社交与日常闲聊',
    titleZh: '兴趣推荐',
    titleJa: '趣味のおすすめ',
    settingZh: '下班后同事小聚',
    partnerZh: '兴趣广泛的同龄同事',
    challengeZh: '推荐自己的爱好并解释吸引点',
    keyExpressions: ['最近ハマっているのは', '〜の魅力は〜ところです', '一度試してみてください'],
  },
  {
    id: 'social-icebreak',
    domain: 'social',
    domainZh: '社交与日常闲聊',
    titleZh: '初次破冰',
    titleJa: '初対面での自己紹介',
    settingZh: '部门欢迎会',
    partnerZh: '友善的新同事',
    challengeZh: '简短自我介绍并找到共同话题',
    keyExpressions: ['〜から参りました', '〜を担当しています', 'よろしくお願いいたします'],
  },
  {
    id: 'social-travel',
    domain: 'social',
    domainZh: '社交与日常闲聊',
    titleZh: '旅行见闻',
    titleJa: '旅行の思い出',
    settingZh: '午休闲聊',
    partnerZh: '热爱旅行的前辈',
    challengeZh: '分享旅行经历并推荐景点',
    keyExpressions: ['〜が一番良かったです', '〜はぜひ行ってみてください', '次は〜に行きたいと思っています'],
  },

  // ──── 生活手续与契约 ────
  {
    id: 'admin-movein',
    domain: 'admin',
    domainZh: '生活手续与契约',
    titleZh: '区役所迁入',
    titleJa: '転入届の手続き',
    settingZh: '区役所市民課窗口',
    partnerZh: '公事公办的窗口职员',
    challengeZh: '提交迁入申请并确认所需材料',
    keyExpressions: ['転入届を出したいのですが', '必要な書類を教えてください', '在留カードはこちらです'],
  },
  {
    id: 'admin-bank',
    domain: 'admin',
    domainZh: '生活手续与契约',
    titleZh: '银行开户',
    titleJa: '銀行口座の開設',
    settingZh: '邮储银行/三菱的支店窗口',
    partnerZh: '谨慎的银行柜员',
    challengeZh: '说明开户目的并确认提款卡类型',
    keyExpressions: ['口座を開設したいのですが', '給与振込用です', 'キャッシュカードの発行は'],
  },
  {
    id: 'admin-delivery',
    domain: 'admin',
    domainZh: '生活手续与契约',
    titleZh: '快递改派',
    titleJa: '再配達の依頼',
    settingZh: '电话联系快递公司',
    partnerZh: '高效的客服',
    challengeZh: '提供不在票信息并指定再配达时间',
    keyExpressions: ['不在票の番号は〜です', '明日の午前中にお願いできますか', '時間指定は可能ですか'],
  },
  {
    id: 'admin-rent',
    domain: 'admin',
    domainZh: '生活手续与契约',
    titleZh: '租房问询',
    titleJa: '賃貸物件の問い合わせ',
    settingZh: '不动产中介店铺',
    partnerZh: '推销但有帮助的不动产经纪人',
    challengeZh: '说明预算和需求并询问初期费用',
    keyExpressions: ['家賃は〜万円以内で', '初期費用はどのくらいですか', '内見は可能ですか'],
  },
]

/** 从词库中随机抽取一个场景 */
export function drawRandomScenario(excludeId?: string): VocabScenario {
  const candidates = excludeId
    ? VOCAB_BANK.filter(s => s.id !== excludeId)
    : VOCAB_BANK
  return candidates[Math.floor(Math.random() * candidates.length)]
}

/** 按领域分组 */
export function groupByDomain(): Map<string, VocabScenario[]> {
  const map = new Map<string, VocabScenario[]>()
  for (const s of VOCAB_BANK) {
    const list = map.get(s.domain) ?? []
    list.push(s)
    map.set(s.domain, list)
  }
  return map
}
