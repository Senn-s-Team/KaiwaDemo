/**
 * [INPUT]: 当前遥测同意状态与明确选择回调
 * [OUTPUT]: 渲染不阻断训练的无障碍技术验证同意选择与原生隐私详情
 * [POS]: src/components 的首页内嵌隐私选择，不拥有持久化或遥测上传
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ValidationConsent } from '../lib/validation-consent'

interface ValidationConsentProps {
  consent: ValidationConsent
  onDecision: (decision: 'accepted' | 'declined') => void
  onRevoke: () => void
}

export function ValidationConsent({ consent, onDecision, onRevoke }: ValidationConsentProps): React.JSX.Element | null {
  if (consent === 'undecided') {
    return (
      <section className="validation-consent" aria-labelledby="validation-consent-heading">
        <h2 id="validation-consent-heading">帮助改进练习稳定性</h2>
        <p>可选发送不含对话、音频或可直接识别身份的信息的技术指标，用于验证练习流程是否正常工作。</p>
        <div className="validation-consent-actions">
          <button className="secondary-button" type="button" onClick={() => onDecision('declined')}>暂不参与</button>
          <button className="primary-button" type="button" onClick={() => onDecision('accepted')}>同意参与</button>
        </div>
        <details className="validation-consent-details">
          <summary>查看隐私说明</summary>
          <p>仅记录流程阶段、匿名设备类别、耗时和汇总计数。不会上传语音、转写文本、对话内容、访问令牌或完整浏览器标识。指标 payload 没有 IP 字段，Cloudflare 网络日志按平台配置处理。服务器事件与复盘最多保留 180 天，汇总最多保留 365 天；撤销会停止新的发送并清除本机待发送数据，不会删除已送达记录。</p>
        </details>
      </section>
    )
  }

  if (consent === 'accepted') {
    return (
      <aside className="validation-consent-status" aria-label="技术验证参与状态">
        <span>已参与匿名技术验证。</span>
        <button className="text-button" type="button" onClick={onRevoke}>撤销同意</button>
      </aside>
    )
  }

  return null
}
