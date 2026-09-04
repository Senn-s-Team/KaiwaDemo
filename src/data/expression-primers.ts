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

export function getExpressionPrimers(
  scenarioId?: string,
  variantId?: string,
  dynamicData?: { hintStrategy?: string; tone?: string; relationship?: string } | null,
): ExpressionPrimerItem[] {
  if (scenarioId && variantId && CATALOG_EXPRESSION_PRIMERS[scenarioId]?.[variantId]) {
    return CATALOG_EXPRESSION_PRIMERS[scenarioId][variantId]
  }
  if (scenarioId && CATALOG_EXPRESSION_PRIMERS[scenarioId]) {
    const firstVariant = Object.values(CATALOG_EXPRESSION_PRIMERS[scenarioId])[0]
    if (firstVariant) return firstVariant
  }

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
