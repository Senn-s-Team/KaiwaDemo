import type { SessionReport } from '../types'

export interface PracticeTrendMetric {
  labelZh: string
  previousDisplay: string
  currentDisplay: string
  deltaDisplay: string
  direction: 'better' | 'worse' | 'neutral' | 'na'
}

export interface PracticeTrendSummary {
  hasPrevious: boolean
  metrics: PracticeTrendMetric[]
  narrativeZh: string
}

export function buildPracticeTrend(
  previousReport: SessionReport | null,
  currentReport: SessionReport,
): PracticeTrendSummary {
  if (!previousReport) {
    return {
      hasPrevious: false,
      metrics: [],
      narrativeZh: '当前为第一次练习，再次练习同场景后可查看趋势对比。',
    }
  }

  const prevTotals = previousReport.totals
  const currTotals = currentReport.totals

  const prevLatency = prevTotals.avgSpeechStartLatencyMs
  const currLatency = currTotals.avgSpeechStartLatencyMs

  let latencyDeltaText = '—'
  let latencyDir: PracticeTrendMetric['direction'] = 'neutral'
  if (prevLatency !== null && currLatency !== null) {
    const diff = currLatency - prevLatency
    if (diff < -150) {
      latencyDeltaText = `快 ${(Math.abs(diff) / 1000).toFixed(1)} 秒`
      latencyDir = 'better'
    } else if (diff > 150) {
      latencyDeltaText = `慢 ${(diff / 1000).toFixed(1)} 秒`
      latencyDir = 'worse'
    } else {
      latencyDeltaText = '持平'
      latencyDir = 'neutral'
    }
  }

  const rerecordDiff = currTotals.rerecordCount - prevTotals.rerecordCount
  const rerecordDir: PracticeTrendMetric['direction'] =
    rerecordDiff < 0 ? 'better' : rerecordDiff > 0 ? 'worse' : 'neutral'
  const rerecordDeltaText =
    rerecordDiff < 0
      ? `减少 ${Math.abs(rerecordDiff)} 次`
      : rerecordDiff > 0
        ? `增加 ${rerecordDiff} 次`
        : '持平'

  const hintDiff = currTotals.hintRoundsCount - prevTotals.hintRoundsCount
  const hintDir: PracticeTrendMetric['direction'] =
    hintDiff < 0 ? 'better' : hintDiff > 0 ? 'worse' : 'neutral'
  const hintDeltaText =
    hintDiff < 0
      ? `减少 ${Math.abs(hintDiff)} 轮`
      : hintDiff > 0
        ? `增加 ${hintDiff} 轮`
        : '持平'

  const modDiff =
    currTotals.transcriptModificationCount - prevTotals.transcriptModificationCount
  const modDir: PracticeTrendMetric['direction'] =
    modDiff < 0 ? 'better' : modDiff > 0 ? 'worse' : 'neutral'
  const modDeltaText =
    modDiff < 0
      ? `减少 ${Math.abs(modDiff)} 次`
      : modDiff > 0
        ? `增加 ${modDiff} 次`
        : '持平'

  const metrics: PracticeTrendMetric[] = [
    {
      labelZh: '平均回答启动时间',
      previousDisplay: prevLatency !== null ? `${(prevLatency / 1000).toFixed(1)} 秒` : '未记录',
      currentDisplay: currLatency !== null ? `${(currLatency / 1000).toFixed(1)} 秒` : '未记录',
      deltaDisplay: latencyDeltaText,
      direction: latencyDir,
    },
    {
      labelZh: '重录次数',
      previousDisplay: `${prevTotals.rerecordCount} 次`,
      currentDisplay: `${currTotals.rerecordCount} 次`,
      deltaDisplay: rerecordDeltaText,
      direction: rerecordDir,
    },
    {
      labelZh: '提示使用轮数',
      previousDisplay: `${prevTotals.hintRoundsCount} 轮`,
      currentDisplay: `${currTotals.hintRoundsCount} 轮`,
      deltaDisplay: hintDeltaText,
      direction: hintDir,
    },
    {
      labelZh: '转写修改次数',
      previousDisplay: `${prevTotals.transcriptModificationCount} 次`,
      currentDisplay: `${currTotals.transcriptModificationCount} 次`,
      deltaDisplay: modDeltaText,
      direction: modDir,
    },
  ]

  const observations: string[] = []
  if (latencyDir === 'better') observations.push('开口响应更加迅速')
  if (rerecordDir === 'better') observations.push('重录次数明显减少')
  if (hintDir === 'better') observations.push('更少依赖提示')
  if (modDir === 'better') observations.push('转写一次确认率提升')

  const narrativeZh =
    observations.length > 0
      ? `第二次练习呈现积极趋势：${observations.join('、')}。`
      : '同场景第二次练习完成，各项节奏与操作保持平稳。'

  return {
    hasPrevious: true,
    metrics,
    narrativeZh,
  }
}
