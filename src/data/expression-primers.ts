import { VOCAB_BANK, type VocabScenario } from './vocab-bank'

export interface ExpressionPrimerItem {
  phraseJa: string
  phraseRuby?: string
  meaningZh: string
  timingZh: string
}

export const CATALOG_EXPRESSION_PRIMERS: Record<string, Record<string, ExpressionPrimerItem[]>> = {
  'weekend-chat': {
    'casual-coworker': [
      {
        phraseJa: '〜てのんびり過ごしました',
        phraseRuby: '〜てのんびり[過|す]ごしました',
        meaningZh: '悠闲地度过了...',
        timingZh: '描述周末在家的放松状态',
      },
      {
        phraseJa: '気分転換に〜に行ってきました',
        phraseRuby: '[気分転換|きぶんてんかん]に〜に[行|い]ってきました',
        meaningZh: '顺便换换心情去了一趟...',
        timingZh: '提到外出散步、看电影或探店时',
      },
      {
        phraseJa: '〜さんはどうでしたか？',
        phraseRuby: '〜さんはどうでしたか？',
        meaningZh: '您（周末）过得怎么样？',
        timingZh: '说完自己后自然地把话轮抛还给同事',
      },
    ],
    'monday-catchup': [
      {
        phraseJa: 'いちばん印象に残っているのは〜ですね',
        phraseRuby: 'いちばん[印象|いんしょう]に[残|のこ]っているのは〜ですね',
        meaningZh: '印象最深的是...呢',
        timingZh: '回答“最开心的事是什么”时起手',
      },
      {
        phraseJa: '久しぶりに〜ができてリフレッシュできました',
        phraseRuby: '[久|ひさ]しぶりに〜ができてリフレッシュできました',
        meaningZh: '久违地做了...感觉满血复活了',
        timingZh: '分享做成某事或与朋友聚会的满足感',
      },
      {
        phraseJa: '今週も頑張りましょう',
        phraseRuby: '[今週|こんしゅう]も[頑張|がんば]りましょう',
        meaningZh: '这周也一起加油吧',
        timingZh: '周一晨间寒暄收尾时的得体结束语',
      },
    ],
  },
  'order-change': {
    'restaurant-dish': [
      {
        phraseJa: 'それなら、〜に変更していただくことは可能ですか？',
        phraseRuby: 'それなら、〜に[変更|へんこう]していただくことは[可能|かのう]ですか？',
        meaningZh: '既然那样，能麻烦帮我换成...吗？',
        timingZh: '得知原菜品售罄，改点其他替代菜品时',
      },
      {
        phraseJa: 'おすすめの〜をお願いできますか？',
        phraseRuby: 'おすすめの〜をお[願|ねが]いできますか？',
        meaningZh: '能麻烦来一份您推荐的...吗？',
        timingZh: '不知道选什么、直接向店员求推荐时',
      },
      {
        phraseJa: 'こちらの〜でお願いします',
        phraseRuby: 'こちらの〜でお[願|ねが]いします',
        meaningZh: '就决定要这个...了，拜托了',
        timingZh: '最终敲定并确认新菜品时的爽快定锤',
      },
    ],
    'cafe-takeout': [
      {
        phraseJa: 'サイズを〜に変更していただきたいのですが',
        phraseRuby: 'サイズを〜に[変更|へんこう]していただきたいのですが',
        meaningZh: '我想把规格大小换成...不知是否方便',
        timingZh: '提出修改咖啡规格的委婉诉求起手式',
      },
      {
        phraseJa: 'テイクアウトのままで大丈夫です',
        phraseRuby: 'テイクアウトのままで[大丈夫|だいじょうぶ]です',
        meaningZh: '维持外带就可以，没问题',
        timingZh: '店员询问店内还是带走时的干脆确认',
      },
      {
        phraseJa: 'ご対応ありがとうございます',
        phraseRuby: 'ご[対応|たいおう]ありがとうございます',
        meaningZh: '感谢您的配合协助',
        timingZh: '店员帮忙修改完毕后的得体感谢',
      },
    ],
  },
  'schedule-change': {
    'meeting-reschedule': [
      {
        phraseJa: '恐れ入りますが、お時間を調整いただくことは可能でしょうか',
        phraseRuby: '[恐|おそ]れ[入|い]りますが、お[時間|じかん]を[調整|ちょうせい]いただくことは[可能|かのう]でしょうか',
        meaningZh: '实在抱歉，能否麻烦您协调一下时间呢',
        timingZh: '向工作伙伴或客户提出改期时的最高频委婉起手',
      },
      {
        phraseJa: 'あいにくその時間帯は先約がありまして、〜',
        phraseRuby: 'あいにくその[時間帯|じかんたい]は[先約|せんやく]がありまして、〜',
        meaningZh: '不巧那个时间段已有先约，若是...',
        timingZh: '委婉说明无法出席的原因并预备给备选时段',
      },
      {
        phraseJa: '〜日の〜時以降でしたら都合がつきます',
        phraseRuby: '〜[日|にち]の〜[時|じ][以降|いこう]でしたら[都合|つごう]がつきます',
        meaningZh: '如果是...号的...点之后，我都是方便的',
        timingZh: '主动给出具体明确的候选时间',
      },
    ],
    'appointment-reschedule': [
      {
        phraseJa: '予約の日時を変更していただきたいのですが、空きはありますでしょうか',
        phraseRuby: '[予約|よやく]の[日時|にちじ]を[変更|へんこう]していただきたいのですが、[空|あ]きはありますでしょうか',
        meaningZh: '我想修改预约的时间，请问还有空档吗',
        timingZh: '联系诊所/美容院等机构改约时的标准句型',
      },
      {
        phraseJa: '今週の〜曜日か、来週の午前中はいかがでしょうか',
        phraseRuby: '[今週|こんしゅう]の〜[曜日|ようび]か、[来週|らいしゅう]の[午前中|ごぜんちゅう]はいかがでしょうか',
        meaningZh: '请问本周...或者下周上午方便吗',
        timingZh: '灵活协调多个时间段选项',
      },
      {
        phraseJa: '急な変更で申し訳ありません。助かります',
        phraseRuby: '[急|きゅう]な[変更|へんこう]で[申|もう]し[訳|わけ]ありません。[助|たす]かります',
        meaningZh: '突然变更实在不好意思，帮大忙了',
        timingZh: '对方确认可以改期后的真诚致谢',
      },
    ],
  },
  'work-progress': {
    'progress-report': [
      {
        phraseJa: '現在の進捗状況について共有させていただきます',
        phraseRuby: '[現在|げんざい]の[進捗状況|しんちょくじょうきょう]について[共有|きょうゆう]させていただきます',
        meaningZh: '向您汇报同步一下目前的进展情况',
        timingZh: '正式向同事或上级开启进度同步时',
      },
      {
        phraseJa: '〜までは順調に完了しておりまして、現在は〜の段階です',
        phraseRuby: '〜までは[順調|じゅんちょう]に[完了|かんりょう]しておりまして、[現在|げんざい]は〜の[段階|だんかい]です',
        meaningZh: '...为止均已顺利完成，目前正在进行...阶段',
        timingZh: '结构化汇报阶段性成果与当前重心',
      },
      {
        phraseJa: '予定通り〜日までに目処が立つ見込みです',
        phraseRuby: '[予定通|よていどお]り〜[日|にち]までに[目処|めど]が[立|た]つ[見込|みこ]みです',
        meaningZh: '预计将按原计划在...号之前出结果/完成',
        timingZh: '给出明确的时间线预估与交付预期',
      },
    ],
    'deadline-risk': [
      {
        phraseJa: '一点、事前にご相談しておきたい懸念点がありまして',
        phraseRuby: '[一点|いってん]、[事前|じぜん]にご[相談|そうだん]しておきたい[懸念点|けねんてん]がありまして',
        meaningZh: '有一点想提前和您商量沟通的风险担忧',
        timingZh: '在风险扩大前尽早发出预警的专业垫话',
      },
      {
        phraseJa: '〜の対応に少し想定以上の時間がかかっております',
        phraseRuby: '〜の[対応|たいおう]に[少|すこ]し[想定以上|そうていいじょう]の[時間|じかん]がかかっております',
        meaningZh: '在...的处理上花的时间比预期稍长了一些',
        timingZh: '客观测度阻碍原因，不找借口但讲明现状',
      },
      {
        phraseJa: '〜までに提出できるよう優先度を調整しています',
        phraseRuby: '〜までに[提出|ていしゅつ]できるよう[優先度|ゆうせんど]を[調整|ちょうせい]しています',
        meaningZh: '为了能在...前交付，正在协调调整优先级',
        timingZh: '同步自己的应对挽救方案（Solution-oriented）',
      },
    ],
  },
  'conversation-repair': {
    'confirm-meeting': [
      {
        phraseJa: '念のため、もう一度確認させていただいてもよろしいでしょうか',
        phraseRuby: '[念|ねん]のため、もう[一度|いちど][確認|かくにん]させていただいてもよろしいでしょうか',
        meaningZh: '为以防万一，能否允许我再向您确认一遍',
        timingZh: '避免听错或遗漏关键会议信息时的安全垫式请求',
      },
      {
        phraseJa: '先ほどおっしゃったのは、〜という理解で合っていますか？',
        phraseRuby: '[先|さき]ほどおっしゃったのは、〜という[理解|りかい]で[合|あ]っていますか？',
        meaningZh: '您刚才所说的，我理解为...是对的吗？',
        timingZh: '将对方长句子压缩为核心信息进行复述核对',
      },
      {
        phraseJa: '聞き取れず失礼いたしました。ありがとうございます',
        phraseRuby: '[聞|き]き[取|と]れず[失礼|しつれい]いたしました。ありがとうございます',
        meaningZh: '刚才没听清实在失礼了，非常感谢',
        timingZh: '对方重新解释清楚后的得体致谢',
      },
    ],
    'confirm-reservation': [
      {
        phraseJa: '恐れ入ります、電波が途切れてしまいまして、もう一度伺えますか',
        phraseRuby: '[恐|おそ]れ[入|い]ります、[電波|でんぱ]が[途切|とぎ]れてしまいまして、もう[一度|いちど][伺|うかが]えますか',
        meaningZh: '实在不好意思信号断了一下，能再请您说一遍吗',
        timingZh: '电话或线上交流听不清时的专业挽救话术',
      },
      {
        phraseJa: '確認ですが、日時は〜、人数は〜名様でよろしかったでしょうか',
        phraseRuby: '[確認|かくにん]ですが、[日時|にちじ]は〜、[人数|にんずう]は〜[名様|めいさま]でよろしかったでしょうか',
        meaningZh: '向您确认一下，时间是...，人数是...对吗',
        timingZh: '服务业或预约确认中的关键要素清单式复核',
      },
      {
        phraseJa: '間違いございません。よろしくお願いいたします',
        phraseRuby: '[間違|まちが]いございません。よろしくお[願|ねが]いいたします',
        meaningZh: '没有错误，完全一致。麻烦您了',
        timingZh: '信息全部对齐后的终章确认',
      },
    ],
  },
}

// 针对灵感速练场景库的专属武器映射（覆盖全部高频场景）
export const SPARK_SCENARIO_PRIMERS: Record<string, ExpressionPrimerItem[]> = {
  'daily-cafe': [
    {
      phraseJa: '甘さ控えめでお願いします',
      phraseRuby: '[甘|あま]さ[控|ひか]えめでお[願|ねが]いします',
      meaningZh: '甜度减半 / 做微糖',
      timingZh: '向咖啡师说明口味甜度偏好时',
    },
    {
      phraseJa: 'おすすめのコーヒー豆やメニューはありますか？',
      phraseRuby: 'おすすめのコーヒー[豆|まめ]やメニューはありますか？',
      meaningZh: '请问有推荐的咖啡豆或饮品吗？',
      timingZh: '不知道选什么向店主求推荐时',
    },
    {
      phraseJa: 'テイクアウトでお願いできますか？',
      phraseRuby: 'テイクアウトでお[願|ねが]いできますか？',
      meaningZh: '能麻烦做成外带吗？',
      timingZh: '确认带走或打包时',
    },
  ],
  'daily-conbini': [
    {
      phraseJa: 'すみません、〜はどのあたりに置いてありますか？',
      phraseRuby: 'すみません、〜はどのあたりに[置|お]いてありますか？',
      meaningZh: '不好意思，请问...大概放在哪个位置？',
      timingZh: '在便利店找不到商品位置时向店员发问',
    },
    {
      phraseJa: '袋は大丈夫です、シールだけでお願いします',
      phraseRuby: '[袋|ふくろ]は[大丈夫|だいじょうぶ]です、シールだけでお[願|ねが]いします',
      meaningZh: '不需要塑料袋，贴个已购标签就行',
      timingZh: '店员询问是否需要塑料袋时',
    },
    {
      phraseJa: '〜で支払いたいのですが、使えますか？',
      phraseRuby: '〜で[支払|しはら]いたいのですが、[使|つか]えますか？',
      meaningZh: '我想用...支付，请问支持吗？',
      timingZh: '确认电子支付或信用卡时',
    },
  ],
  'daily-salon': [
    {
      phraseJa: '全体的に長さを少し短めにしてください',
      phraseRuby: '[全体的|ぜんたいてき]に[長|なが]さを[少|すこ]し[短|みじか]めにしてください',
      meaningZh: '整体长度请帮我稍微剪短一点',
      timingZh: '向发型师说明修剪基调时',
    },
    {
      phraseJa: '毛量を少しすいて、軽さを出したいです',
      phraseRuby: '[毛量|もうりょう]を[少|すこ]しすいて、[軽|かる]さを[出|だ]したいです',
      meaningZh: '希望能稍微打薄发量，看起来轻盈一些',
      timingZh: '头发厚重提出打薄要求时',
    },
    {
      phraseJa: '朝のセットがしやすい感じでお願いします',
      phraseRuby: '[朝|あさ]のセットがしやすい[感|かん]じでお[願|ねが]いします',
      meaningZh: '请剪成早上容易打理的感觉',
      timingZh: '提出日常好打理的造型需求时',
    },
  ],
  'daily-izakaya': [
    {
      phraseJa: 'とりあえず生ビールを二つお願いします',
      phraseRuby: 'とりあえず[生|なま]ビールを[二|ふた]つお[願|ねが]いします',
      meaningZh: '先来两杯生啤',
      timingZh: '居酒屋落座后的首次开点黄金句',
    },
    {
      phraseJa: '本日のおすすめの料理は何ですか？',
      phraseRuby: '[本日|ほんじつ]のおすすめの[料理|りょうり]は[何|なん]ですか？',
      meaningZh: '请问今天有什么招牌菜品吗？',
      timingZh: '向店员询问当日特色或新鲜鱼鲜时',
    },
    {
      phraseJa: 'お会計は別々でお願いできますでしょうか',
      phraseRuby: 'お[会計|かいけい]は[別々|べつべつ]でお[願|ねが]いできますでしょうか',
      meaningZh: '买单能麻烦分开结吗？',
      timingZh: '结账提出 AA 分账时',
    },
  ],
  'work-leave': [
    {
      phraseJa: '私事で大変恐縮ですが、休暇をいただきたくご相談に伺いました',
      phraseRuby: '[私事|わたくしごと]で[大変恐縮|たいへんきょうしゅく]ですが、[休暇|きゅうか]をいただきたくご[相談|そうだん]に[伺|うかが]いました',
      meaningZh: '因私事非常抱歉，我想向您申请请假特来商量',
      timingZh: '向上司正式报备请假事由的稳妥起手',
    },
    {
      phraseJa: '不在中の業務につきましては、〇〇さんに引き継ぎをお願いしてあります',
      phraseRuby: '[不在中|ふざいちゅう]の[業務|ぎょうむ]につきましては、〇〇さんに[引|ひ]き[継|つ]ぎをお[願|ねが]いしてあります',
      meaningZh: '请假期间的工作已提前拜托给某某同事交接代理',
      timingZh: '主动说明交接安排消除上司担忧',
    },
    {
      phraseJa: '急なご相談となりご迷惑をおかけしますが、よろしくお願いいたします',
      phraseRuby: '[急|きゅう]なご[相談|そうだん]となりご[迷惑|めいわく]をおかけしますが、よろしくお[願|ねが]いいたします',
      meaningZh: '临时商量给您添麻烦了，拜托您了',
      timingZh: '请假沟通收尾时的得体感谢',
    },
  ],
  'emergency-train': [
    {
      phraseJa: '電車の遅延証明書をいただくことはできますか？',
      phraseRuby: '[電車|でんしゃ]の[遅延証明書|ちえんしょうめいしょ]をいただくことはできますか？',
      meaningZh: '请问能给我开一份电车延误证明吗？',
      timingZh: '因列车延误向站务员索取迟到凭证时',
    },
    {
      phraseJa: '〜駅まで振替輸送は行っていますでしょうか？',
      phraseRuby: '〜[駅|えき]まで[振替輸送|ふりかえゆそう]は[行|おこな]っていますでしょうか？',
      meaningZh: '请问去往某某站有联运接驳替代运行吗？',
      timingZh: '寻找其他铁路或地铁换乘路线时',
    },
    {
      phraseJa: '一番早く着く別のルートを教えていただけますか',
      phraseRuby: '[一番早|いちばんはや]く[着|つ]く[別|べつ]のルートを[教|おし]えていただけますか',
      meaningZh: '能指引我一条最快到达的目的地路线吗？',
      timingZh: '向站务员寻求紧急替代方案时',
    },
  ],
}

/**
 * 根据场景 ID、变体、动态数据与灵感速练词库智能推导最精准的 3 组进阶表达
 */
export function getExpressionPrimers(
  scenarioId?: string,
  variantId?: string,
  dynamicData?: {
    titleZh?: string
    summaryZh?: string
    aiRole?: string
    hintStrategy?: string
    tone?: string
    relationship?: string
  } | null,
  activeSpark?: VocabScenario | null,
): ExpressionPrimerItem[] {
  // 1. 固定场景直接精确命中
  if (scenarioId && variantId && CATALOG_EXPRESSION_PRIMERS[scenarioId]?.[variantId]) {
    return CATALOG_EXPRESSION_PRIMERS[scenarioId][variantId]
  }
  if (scenarioId && CATALOG_EXPRESSION_PRIMERS[scenarioId]) {
    const firstVariant = Object.values(CATALOG_EXPRESSION_PRIMERS[scenarioId])[0]
    if (firstVariant) return firstVariant
  }

  // 2. 灵感速练显式传入时直接精准匹配
  if (activeSpark) {
    if (SPARK_SCENARIO_PRIMERS[activeSpark.id]) {
      return SPARK_SCENARIO_PRIMERS[activeSpark.id]
    }
    // 若无手写精细配置，从 activeSpark.keyExpressions 自动生成专属武器
    if (activeSpark.keyExpressions.length > 0) {
      return activeSpark.keyExpressions.slice(0, 3).map((expr) => ({
        phraseJa: expr,
        meaningZh: `${activeSpark.titleZh}场景核心必用表达`,
        timingZh: `在交流挑战「${activeSpark.challengeZh}」时调用`,
      }))
    }
  }

  // 3. 动态场景基于标题 / 角色 / 摘要关键词进行主题命中
  const contextStr = `${dynamicData?.titleZh || ''} ${dynamicData?.summaryZh || ''} ${dynamicData?.aiRole || ''}`

  // 咖啡 / 饮品 / 下午茶
  if (/カフェ|咖啡|珈琲|コーヒー|ラテ|喫茶/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['daily-cafe']
  }
  // 便利店 / 购物 / 超市
  if (/コンビニ|便利店|セブン|ローソン|スーパー|買い物|商品/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['daily-conbini']
  }
  // 美发 / 理发
  if (/美容|美发|理发|サロン|髪|ヘア/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['daily-salon']
  }
  // 居酒屋 / 餐厅 / 吃饭点单
  if (/居酒屋|レストラン|食事|注文|点单|定食|ディナー|乾杯/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['daily-izakaya']
  }
  // 请假 / 调休
  if (/休|休暇|请假|有給|休業|体調/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['work-leave']
  }
  // 电车 / 地铁 / 交通延误
  if (/電車|遅延|交通|駅|切符|列車|遅刻/i.test(contextStr)) {
    return SPARK_SCENARIO_PRIMERS['emergency-train']
  }

  // 尝试在 VOCAB_BANK 遍历中匹配标题
  const matchedVocab = VOCAB_BANK.find((v) => contextStr.includes(v.titleZh) || contextStr.includes(v.titleJa))
  if (matchedVocab && matchedVocab.keyExpressions.length > 0) {
    return matchedVocab.keyExpressions.slice(0, 3).map((expr) => ({
      phraseJa: expr,
      meaningZh: `${matchedVocab.titleZh}核心推荐表达`,
      timingZh: matchedVocab.challengeZh,
    }))
  }

  // 4. 语体通配兜底（分商务/日常）
  const tone = dynamicData?.tone || ''
  const isFormal =
    tone.includes('敬語') ||
    tone.includes('丁寧') ||
    tone.includes('ビジネス') ||
    tone.includes('改まった')

  if (isFormal) {
    return [
      {
        phraseJa: '恐れ入りますが、〜ていただけますでしょうか',
        phraseRuby: '[恐|おそ]れ[入|い]りますが、〜ていただけますでしょうか',
        meaningZh: '实在不好意思，能否麻烦您...',
        timingZh: '礼貌提出要求或需要对方协助时',
      },
      {
        phraseJa: '〜についてご確認いただけますと幸いです',
        phraseRuby: '〜についてご[確認|かくにん]いただけますと[幸|さいわ]いです',
        meaningZh: '若能与您确认...将不胜感激',
        timingZh: '需要核实细节或寻求反馈时',
      },
      {
        phraseJa: 'お忙しいところ恐縮ですが、よろしくお願いいたします',
        phraseRuby: 'お[忙|いそが]しいところ[恐縮|きょうしゅく]ですが、よろしくお[願|ねが]いいたします',
        meaningZh: '百忙之中给您添麻烦了，拜托您了',
        timingZh: '沟通收尾时的得体致敬',
      },
    ]
  }

  return [
    {
      phraseJa: 'すみません、〜についてちょっと聞いてもいいですか？',
      phraseRuby: 'すみません、〜についてちょっと[聞|き]いてもいいですか？',
      meaningZh: '不好意思，关于...能稍微问你一下吗？',
      timingZh: '向同龄人、店员或熟人自然搭话起手',
    },
    {
      phraseJa: 'できれば〜していただけると助かるのですが',
      phraseRuby: 'できれば〜していただけると[助|たす]かるのですが',
      meaningZh: '如果可以的话，能帮我...就太感谢了',
      timingZh: '提出轻微诉求但不想显得太强硬时',
    },
    {
      phraseJa: 'ありがとうございます、助かりました！',
      phraseRuby: 'ありがとうございます、[助|たす]かりました！',
      meaningZh: '太谢谢你了，帮大忙了！',
      timingZh: '得到解答或达成一致时的自然收尾',
    },
  ]
}
