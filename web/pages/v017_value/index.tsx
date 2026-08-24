import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { ONES } from '@ones-open/web-sdk'
import './index.css'

type JobState = {
  jobId: string
  status: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed'
  stage: string
  progress: number
  error: string
  snapshotKey: string
}

type HealthMatrix = {
  results: Array<{ dimension: string; maturity: string; reason?: string; coverage: number; confidence: string; suggestion?: string }>
  opportunities: Array<{ moduleKey: string; moduleName: string; reason: string; evidence: string }>
}

/** 环比结构（value-standard §2.1） */
type Compared = {
  current: number | null
  previous: number | null
  delta: number | null
  deltaPercent: number | null
  deltaPP: number | null
  trendLabel: '显著提升' | '略有提升' | '基本持平' | '略有下降' | '显著下降' | '新增' | '未知'
  direction: 'up' | 'down' | 'neutral'
  isImprovement: boolean | null
  sampleSize: number
}

/** v0.2 价值报告结构（四轴九维度 + 亮点） */
type ValueMetrics = {
  scope: { activeProjects: Compared; newProjects: number; status: string }
  requirement: {
    typeSplit: boolean
    mappingCoverage: number | null
    created: Compared
    delivered: Compared
    cycleP50Hours: Compared
    onTimeRate: Compared
    sprintLinkedRate: Compared
    status: string
  }
  defect: {
    typeSplit: boolean
    found: Compared
    fixed: Compared
    open: number
    fixCycleP50Hours: Compared
    reopenRate: Compared
    status: string
  }
  sprintExecution: {
    finished: Compared
    onTimeRate: Compared
    deliveredItems: Compared
    cadenceWeeks: number
    finishTrend: Array<{ week: string; count: number }>
    status: string
  }
  deliveryEfficiency: {
    cycleP50Hours: Compared
    cycleP75Hours: Compared
    weeklyThroughput: Compared
    onTimeRate: Compared
    reopenRate: Compared
    throughputTrend: Array<{ week: string; created: number; completed: number }>
    status: string
  }
  collaboration: {
    participants: Compared
    manualActions: Compared
    activeWeeks: number
    weeklyTrend: Array<{ week: string; actions: number; participants: number }>
    status: string
  }
  discipline: {
    assigneeFillRate: Compared
    dueDateFillRate: Compared
    sprintDateDisciplineRate: Compared
    sprintLengthMedianDays: number | null
    status: string
  }
  worklogPractice: {
    estimateCoverage: Compared
    spentCoverage: Compared
    estimateAccuracyMedian: number | null
    pairedSampleSize: number
    status: string
  }
  knowledge: {
    wikiLinkedCount: Compared
    wikiLinkedRate: Compared
    wikiSpaces: number | null
    status: string
  }
  highlights: Array<{ text: string; metric: string; kind: 'improvement' | 'new-practice' | 'achievement' }>
  concerns: Array<{ text: string; metric: string }>
}

/** v0.1 旧结构（兼容历史快照） */
type LegacyMetrics = {
  projects: { newProjects: number; activeProjects: number; status: string }
  sprints: { created: number; finished: number; onTimeFinished: number; status: string }
  issues: { created: number; firstCompleted: number; reopened: number; throughputTrend: Array<{ week: string; created: number; completed: number }>; status: string }
  cycleTime: { p50Hours: number | null; p75Hours: number | null; sampleSize: number; status: string }
  collaboration: { manualFieldChanges: number; participants: number; weeklyTrend: Array<{ week: string; actions: number; participants: number }>; status: string }
  planFulfillment: { total: number; onTime: number; rate: number | null; status: string }
}

type ReportData = {
  snapshotId: string
  metrics: ValueMetrics | LegacyMetrics
  narrative: Record<string, string>
  coverage: number
  ruleVersion: string
  createdAt: number
}

/** 团队选择器条目（GET /api/teams） */
type TeamInfo = {
  uuid: string
  name: string
  accessible: boolean
  whitelisted: boolean
  whitelistEmpty: boolean
}

/** 识别 v0.2 结构（有 scope 维度）；旧平铺按 legacy 渲染 */
const isV2 = (m: ValueMetrics | LegacyMetrics): m is ValueMetrics => 'scope' in m && 'highlights' in m

/** 后端 metrics_json 兼容两种结构：旧平铺 / 新 {value, health} */
const normalizeReport = (report: ReportData): { report: ReportData; health: HealthMatrix | null } => {
  const metrics = report.metrics as unknown as Partial<ValueMetrics & LegacyMetrics> & { value?: ValueMetrics | LegacyMetrics; health?: HealthMatrix }
  if (metrics.value) {
    return { report: { ...report, metrics: metrics.value }, health: metrics.health ?? null }
  }
  return { report, health: null }
}

const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  collecting_projects: '采集项目数据',
  collecting_sprints: '采集迭代数据',
  collecting_issue_types: '采集工作项类型',
  collecting_issues: '采集工作项',
  collecting_changelog: '采集变更记录',
  collecting_worklog: '采集工时与知识数据',
  computing_metrics: '计算指标',
  saving_snapshot: '保存快照',
  done: '完成',
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString()

const fmtValue = (cmp: Compared | null | undefined, kind: 'count' | 'ratio' | 'hours' = 'count'): string => {
  if (!cmp || cmp.current == null) return '未知'
  const v = cmp.current
  if (kind === 'ratio') return `${Math.round(v * 100)}%`
  if (kind === 'hours') return `${v} 小时`
  return String(v)
}

/** 环比徽章：按 isImprovement 着色（改善绿 / 退步红 / 持平灰 / 新增蓝 / 未知灰） */
const TrendBadge = ({ cmp }: { cmp: Compared | null | undefined }) => {
  if (!cmp || cmp.trendLabel === '未知' || cmp.current == null || cmp.previous == null) {
    return <span className="trend-badge trend-unknown">未知</span>
  }
  if (cmp.trendLabel === '新增') {
    return <span className="trend-badge trend-new">新增</span>
  }
  if (cmp.trendLabel === '基本持平') {
    return <span className="trend-badge trend-flat">持平</span>
  }
  const up = cmp.trendLabel === '显著提升' || cmp.trendLabel === '略有提升'
  const improve = cmp.isImprovement
  const cls = improve === true ? 'trend-improve' : improve === false ? 'trend-regress' : 'trend-flat'
  const arrow = up ? '↑' : '↓'
  const detail = cmp.deltaPP != null
    ? `${cmp.deltaPP > 0 ? '+' : ''}${cmp.deltaPP}pp`
    : `${cmp.deltaPercent != null && cmp.deltaPercent > 0 ? '+' : ''}${cmp.deltaPercent ?? 0}%`
  return <span className={`trend-badge ${cls}`}>{arrow} {detail}</span>
}

/** 指标行：label + 当前值 + 环比徽章 */
const KV = ({ label, cmp, kind = 'count', hint }: { label: string; cmp: Compared | null | undefined; kind?: 'count' | 'ratio' | 'hours'; hint?: string }) => (
  <div className="kv">
    <span className="kv-label">{label}</span>
    <span className="kv-value">
      {hint ?? fmtValue(cmp, kind)}
      <TrendBadge cmp={cmp} />
    </span>
  </div>
)

const MetricCard = ({ title, status, children }: { title: string; status: string; children: React.ReactNode }) => (
  <div className="metric-card">
    <div className="metric-head">
      <h3>{title}</h3>
      <span className={`status-badge status-${status}`}>{status === 'ok' ? '✓' : status === 'unknown' ? '?' : '!'}</span>
    </div>
    <div className="metric-body">{children}</div>
  </div>
)

const AxisSection = ({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) => (
  <section className="axis-section">
    <div className="axis-head">
      <h2>{title}</h2>
      <span className="axis-subtitle">{subtitle}</span>
    </div>
    <div className="metrics-grid">{children}</div>
  </section>
)

/** 周趋势双柱图（创建/完成 或 行为/人数） */
const TrendChart = ({ data, bars, title }: {
  data: Array<{ week: string; a: number; b: number }>
  bars: [string, string]
  title: string
}) => {
  const max = Math.max(1, ...data.map(t => Math.max(t.a, t.b)))
  return (
    <section className="chart">
      <h2>{title}</h2>
      <div className="trend-chart">
        {data.map(t => (
          <div key={t.week} className="trend-col" title={`${t.week}：${bars[0]} ${t.a} / ${bars[1]} ${t.b}`}>
            <div className="trend-bars">
              <div className="bar created" style={{ height: `${(t.a / max) * 100}%` }} />
              <div className="bar completed" style={{ height: `${(t.b / max) * 100}%` }} />
            </div>
            <span className="trend-label">{t.week.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="dot created" /> {bars[0]} <span className="dot completed" /> {bars[1]}
      </div>
    </section>
  )
}

const ReportPage = () => {
  const [teamUuid, setTeamUuid] = useState('')
  const [teams, setTeams] = useState<TeamInfo[]>([])
  const [userUuid, setUserUuid] = useState('')
  const [job, setJob] = useState<JobState | null>(null)
  const [report, setReport] = useState<ReportData | null>(null)
  const [snapshots, setSnapshots] = useState<Array<{ snapshotId: string; createdAt: number; coverage: number }>>([])
  const [narrativeDraft, setNarrativeDraft] = useState('')
  const [message, setMessage] = useState('')
  const [sections, setSections] = useState({ valueHighlights: true, healthMatrix: false, opportunities: false, appendix: true })
  const [exporting, setExporting] = useState(false)
  const [exportUrl, setExportUrl] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const [team, user] = await Promise.all([ONES.getTeamInfo(), ONES.getUserInfo()])
        const currentTeam = (team as { teamUUID?: string }).teamUUID ?? ''
        const uuid = (user as { uuid?: string }).uuid ?? (user as { userUUID?: string }).userUUID ?? ''
        setUserUuid(uuid)
        setTeamUuid(currentTeam)
        if (currentTeam && uuid) {
          // 团队清单（组织级元数据 + 白名单访问标注）
          const resp = await ONES.fetchApp(`/api/teams?userID=${encodeURIComponent(uuid)}`)
          if (resp.ok) {
            const data = (await resp.json()) as { teams?: TeamInfo[] }
            const list = data.teams ?? []
            setTeams(list)
            // 当前团队不在清单（异常）时回退到第一个可用团队
            if (!list.some(t => t.uuid === currentTeam)) {
              const fallback = list.find(t => t.accessible)
              if (fallback) setTeamUuid(fallback.uuid)
            }
          }
        }
      } catch (error) {
        console.error('[report] init failed:', error)
        setMessage(`上下文获取失败: ${String((error as Error).message)}`)
      }
    }
    init()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  /** 切换团队：清空当前团队全部报告状态，以团队为最大分组重新开始 */
  const switchTeam = (uuid: string) => {
    if (!uuid || uuid === teamUuid) return
    if (pollRef.current) clearInterval(pollRef.current)
    setTeamUuid(uuid)
    setJob(null)
    setReport(null)
    setSnapshots([])
    setExportUrl('')
    setMessage('')
  }

  const loadSnapshots = useCallback(async (team: string, user: string) => {
    if (!team || !user) return
    const resp = await ONES.fetchApp(
      `/api/snapshots?teamID=${encodeURIComponent(team)}&userID=${encodeURIComponent(user)}`,
    )
    if (resp.ok) {
      const data = (await resp.json()) as { snapshots?: typeof snapshots }
      const nextSnapshots = data.snapshots ?? []
      setSnapshots(nextSnapshots)
      // 首次进入时直接打开最新快照，否则页面只有历史列表而没有报告内容。
      if (nextSnapshots.length > 0 && !report) {
        await openSnapshot(nextSnapshots[0].snapshotId)
      }
    }
  }, [report])

  useEffect(() => {
    if (teamUuid && userUuid) void loadSnapshots(teamUuid, userUuid)
  }, [teamUuid, userUuid, loadSnapshots])

  // 轮询任务进度
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return
    const timer = setInterval(async () => {
      try {
        const resp = await ONES.fetchApp(`/api/report-jobs/${job.jobId}?teamID=${encodeURIComponent(teamUuid)}&userID=${encodeURIComponent(userUuid)}`)
        if (!resp.ok) return
        const data = (await resp.json()) as { job?: JobState }
        if (data.job) setJob(data.job)
        if (data.job && (data.job.status === 'succeeded' || data.job.status === 'partial') && data.job.snapshotKey) {
          const snapResp = await ONES.fetchApp(`/api/reports/${data.job.snapshotKey}?teamID=${encodeURIComponent(teamUuid)}&userID=${encodeURIComponent(userUuid)}`)
          if (snapResp.ok) {
            const snapData = (await snapResp.json()) as { report?: ReportData }
            if (snapData.report) {
              const normalized = normalizeReport(snapData.report)
              setReport(normalized.report)
              setNarrativeDraft(normalized.report.narrative?.summary ?? '')
            }
          }
          void loadSnapshots(teamUuid, userUuid)
        }
      } catch {
        // 轮询失败忽略，下次重试
      }
    }, 2000)
    pollRef.current = timer
    return () => clearInterval(timer)
  }, [job, teamUuid, userUuid, loadSnapshots])

  const createJob = async () => {
    setMessage('')
    setReport(null)
    try {
      const resp = await ONES.fetchApp('/api/report-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamID: teamUuid, userID: userUuid }),
      })
      const data = (await resp.json()) as { ok?: boolean; job?: JobState; error?: string }
      if (!data.ok || !data.job) {
        setMessage(`创建失败: ${data.error ?? '未知错误'}`)
        return
      }
      setJob(data.job)
    } catch (error) {
      setMessage(`创建失败: ${String((error as Error).message)}`)
    }
  }

  const openSnapshot = async (snapshotId: string) => {
    const resp = await ONES.fetchApp(`/api/reports/${snapshotId}?teamID=${encodeURIComponent(teamUuid)}&userID=${encodeURIComponent(userUuid)}`)
    if (resp.ok) {
      const data = (await resp.json()) as { report?: ReportData }
      if (data.report) {
        const normalized = normalizeReport(data.report)
        setReport(normalized.report)
        setNarrativeDraft(normalized.report.narrative?.summary ?? '')
      }
    }
  }

  const saveNarrative = async () => {
    if (!report) return
    const resp = await ONES.fetchApp(`/api/reports/${report.snapshotId}/narrative?teamID=${encodeURIComponent(teamUuid)}&userID=${encodeURIComponent(userUuid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userID: userUuid, narrative: { ...report.narrative, summary: narrativeDraft } }),
    })
    const data = (await resp.json()) as { ok?: boolean }
    setMessage(data.ok ? '叙事已保存' : '保存失败')
  }

  const exportPdf = async () => {
    if (!report) return
    setExporting(true)
    setMessage('')
    try {
      const resp = await ONES.fetchApp(`/api/reports/${report.snapshotId}/exports?teamID=${encodeURIComponent(teamUuid)}&userID=${encodeURIComponent(userUuid)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userID: userUuid, sections }),
      })
      const data = (await resp.json()) as { ok?: boolean; export?: { downloadUrl: string }; error?: string }
      if (data.ok && data.export) {
        setExportUrl(data.export.downloadUrl)
        setMessage('PDF 已生成（链接 1 小时内有效）')
      } else {
        setMessage(`导出失败: ${data.error ?? '未知错误'}`)
      }
    } catch (error) {
      setMessage(`导出失败: ${String((error as Error).message)}`)
    } finally {
      setExporting(false)
    }
  }

  const toggleSection = (key: keyof typeof sections) => {
    setSections(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const busy = job?.status === 'pending' || job?.status === 'running'
  const metrics = report?.metrics
  const v2 = metrics ? isV2(metrics) : false

  const throughputData = useMemo(() => {
    if (!metrics) return []
    if (v2) return (metrics as ValueMetrics).deliveryEfficiency.throughputTrend.map(t => ({ week: t.week, a: t.created, b: t.completed }))
    return (metrics as LegacyMetrics).issues.throughputTrend.map(t => ({ week: t.week, a: t.created, b: t.completed }))
  }, [metrics, v2])

  const collaborationData = useMemo(() => {
    if (!metrics) return []
    if (v2) return (metrics as ValueMetrics).collaboration.weeklyTrend.map(t => ({ week: t.week, a: t.actions, b: t.participants }))
    return (metrics as LegacyMetrics).collaboration.weeklyTrend.map(t => ({ week: t.week, a: t.actions, b: t.participants }))
  }, [metrics, v2])

  return (
    <div className="report-page">
      <header className="page-header">
        <h1>客户价值呈现</h1>
        <p className="subtitle">按周期生成不可变报告快照（默认近 90 天对比前 90 天）；应用健康度请切换「应用健康监测」tab</p>
      </header>

      {/* 团队选择器：所有分析以团队为最大分组，先选团队再看数据 */}
      <section className="team-selector">
        <label className="team-label" htmlFor="team-select">分析团队</label>
        <select
          id="team-select"
          className="team-select"
          value={teamUuid}
          onChange={e => switchTeam(e.target.value)}
          disabled={busy}
        >
          {teams.length === 0 && <option value={teamUuid}>{teamUuid ? `当前团队（${teamUuid}）` : '加载中…'}</option>}
          {teams.map(t => (
            <option key={t.uuid} value={t.uuid} disabled={!t.accessible}>
              {t.name || t.uuid}
              {!t.accessible ? '（无访问权限）' : t.whitelistEmpty ? '（待初始化白名单）' : ''}
            </option>
          ))}
        </select>
        {(() => {
          const active = teams.find(t => t.uuid === teamUuid)
          if (active?.whitelistEmpty) {
            return <span className="team-hint">该团队尚未初始化白名单，你将成为首位报告管理员</span>
          }
          return null
        })()}
      </section>

      <section className="toolbar">
        <button className="primary" onClick={createJob} disabled={busy || !teamUuid}>
          {busy ? `生成中… ${job?.progress ?? 0}%（${STAGE_LABELS[job?.stage ?? ''] ?? job?.stage}）` : '生成报告快照'}
        </button>
        {busy && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${job?.progress ?? 0}%` }} />
          </div>
        )}
        {job?.status === 'partial' && <span className="warn" title={job.error || undefined}>部分数据源失败：{job.error || '请重新生成或查看证据'}</span>}
        {job?.status === 'failed' && <span className="error">{job.error || '任务失败'}</span>}
        {message && <span className="info">{message}</span>}
      </section>

      {snapshots.length > 0 && (
        <section className="history">
          <h2>历史快照</h2>
          <div className="snapshot-list">
            {snapshots.map(s => (
              <button key={s.snapshotId} className="snapshot-item" onClick={() => openSnapshot(s.snapshotId)}>
                <span>{fmtDate(s.createdAt)}</span>
                <span className="cov">覆盖率 {Math.round(s.coverage * 100)}%</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {report && metrics && v2 && (() => {
        const m = metrics as ValueMetrics
        return (
          <>
            {/* 价值亮点（置顶） */}
            {m.highlights.length > 0 && (
              <section className="highlights-section">
                <h2>价值亮点</h2>
                <ul className="highlight-list">
                  {m.highlights.map((h, i) => (
                    <li key={`${h.metric}-${i}`} className={`highlight-item kind-${h.kind}`}>
                      <span className="highlight-kind">{h.kind === 'improvement' ? '改善' : h.kind === 'new-practice' ? '新增实践' : '成果'}</span>
                      {h.text}
                    </li>
                  ))}
                </ul>
                {m.concerns.length > 0 && (
                  <div className="concerns-box">
                    <h3>需关注</h3>
                    {m.concerns.map((c, i) => (
                      <p key={`${c.metric}-${i}`}>{c.text}</p>
                    ))}
                  </div>
                )}
              </section>
            )}

            <section className="summary">
              <h2>客户价值摘要</h2>
              <textarea
                className="narrative-editor"
                value={narrativeDraft}
                onChange={e => setNarrativeDraft(e.target.value)}
                rows={4}
              />
              <button className="secondary" onClick={saveNarrative}>
                保存叙事（CSM 可编辑，指标不可改）
              </button>
            </section>

            {/* 统计范围（背景行） */}
            <section className="scope-bar">
              统计范围：活跃项目 <strong>{m.scope.activeProjects.current ?? 0}</strong> 个 · 新建项目 <strong>{m.scope.newProjects}</strong> 个
            </section>

            {/* A 价值成果轴 */}
            <AxisSection title="A · 价值成果" subtitle="做了什么：需求交付、缺陷修复、迭代执行">
              <MetricCard title="需求与价值交付" status={m.requirement.status}>
                {!m.requirement.typeSplit && <p className="card-note">类型拆分不可用，按全类型口径</p>}
                <KV label="需求数" cmp={m.requirement.created} />
                <KV label="需求交付量" cmp={m.requirement.delivered} />
                <KV label="需求交付周期 P50" cmp={m.requirement.cycleP50Hours} kind="hours" />
                <KV label="需求按期率" cmp={m.requirement.onTimeRate} kind="ratio" />
                <KV label="迭代纳入率" cmp={m.requirement.sprintLinkedRate} kind="ratio" />
              </MetricCard>
              <MetricCard title="缺陷与质量" status={m.defect.status}>
                <KV label="缺陷发现" cmp={m.defect.found} />
                <KV label="缺陷修复" cmp={m.defect.fixed} />
                <KV label="遗留缺陷（时点）" cmp={null} hint={String(m.defect.open)} />
                <KV label="修复周期 P50" cmp={m.defect.fixCycleP50Hours} kind="hours" />
                <KV label="缺陷重开率" cmp={m.defect.reopenRate} kind="ratio" />
              </MetricCard>
              <MetricCard title="敏捷迭代执行" status={m.sprintExecution.status}>
                <KV label="完成迭代数" cmp={m.sprintExecution.finished} />
                <KV label="迭代按期率" cmp={m.sprintExecution.onTimeRate} kind="ratio" />
                <KV label="迭代交付工作项" cmp={m.sprintExecution.deliveredItems} />
                <div className="kv"><span className="kv-label">迭代节奏</span><span className="kv-value">{m.sprintExecution.cadenceWeeks} 个自然周有终态迭代</span></div>
              </MetricCard>
            </AxisSection>

            {/* B 效率与确定性轴 */}
            <AxisSection title="B · 效率与确定性" subtitle="更快更稳了吗：交付周期、吞吐、按期率">
              <MetricCard title="交付效率" status={m.deliveryEfficiency.status}>
                <KV label="交付周期 P50" cmp={m.deliveryEfficiency.cycleP50Hours} kind="hours" />
                <KV label="交付周期 P75" cmp={m.deliveryEfficiency.cycleP75Hours} kind="hours" />
                <KV label="周均完成吞吐" cmp={m.deliveryEfficiency.weeklyThroughput} />
              </MetricCard>
              <MetricCard title="计划兑现" status={m.deliveryEfficiency.status}>
                <KV label="按期完成率" cmp={m.deliveryEfficiency.onTimeRate} kind="ratio" />
                <KV label="重开率（降=改善）" cmp={m.deliveryEfficiency.reopenRate} kind="ratio" />
              </MetricCard>
            </AxisSection>

            {/* C 协作与管理轴 */}
            <AxisSection title="C · 协作与管理" subtitle="用得深不深：参与、规范度、工时实践">
              <MetricCard title="协作参与" status={m.collaboration.status}>
                <KV label="参与人数" cmp={m.collaboration.participants} />
                <KV label="人工协作行为" cmp={m.collaboration.manualActions} />
                <div className="kv"><span className="kv-label">协作持续性</span><span className="kv-value">{m.collaboration.activeWeeks} 个自然周</span></div>
              </MetricCard>
              <MetricCard title="管理规范度" status={m.discipline.status}>
                <KV label="负责人填写率" cmp={m.discipline.assigneeFillRate} kind="ratio" />
                <KV label="截止日期填写率" cmp={m.discipline.dueDateFillRate} kind="ratio" />
                <KV label="迭代日期规范率" cmp={m.discipline.sprintDateDisciplineRate} kind="ratio" />
                <div className="kv"><span className="kv-label">迭代长度中位数</span><span className="kv-value">{m.discipline.sprintLengthMedianDays != null ? `${m.discipline.sprintLengthMedianDays} 天` : '样本不足'}</span></div>
              </MetricCard>
              <MetricCard title="工时实践" status={m.worklogPractice.status}>
                <KV label="预估覆盖率" cmp={m.worklogPractice.estimateCoverage} kind="ratio" />
                <KV label="登记覆盖率" cmp={m.worklogPractice.spentCoverage} kind="ratio" />
                <div className="kv"><span className="kv-label">预估准确度</span><span className="kv-value">{m.worklogPractice.estimateAccuracyMedian != null ? `偏差中位数 ${Math.round(m.worklogPractice.estimateAccuracyMedian * 100)}%（n=${m.worklogPractice.pairedSampleSize}）` : '样本不足'}</span></div>
              </MetricCard>
            </AxisSection>

            {/* D 资产沉淀轴 */}
            <AxisSection title="D · 资产沉淀" subtitle="留下了什么：知识沉淀">
              <MetricCard title="知识沉淀" status={m.knowledge.status}>
                <KV label="关联 Wiki 工作项" cmp={m.knowledge.wikiLinkedCount} />
                <KV label="知识沉淀率" cmp={m.knowledge.wikiLinkedRate} kind="ratio" />
                <div className="kv"><span className="kv-label">Wiki 空间数</span><span className="kv-value">{m.knowledge.wikiSpaces != null ? String(m.knowledge.wikiSpaces) : '未知'}</span></div>
              </MetricCard>
            </AxisSection>

            {throughputData.length > 0 && (
              <TrendChart data={throughputData} bars={['创建', '完成']} title="吞吐量趋势（当前周期）" />
            )}
            {collaborationData.length > 0 && (
              <TrendChart data={collaborationData} bars={['协作行为', '参与人数']} title="协作趋势（当前周期）" />
            )}

            <section className="export-panel">
              <h2>导出客户版 PDF</h2>
              <p className="export-hint">客户版默认隐藏内部错误细节与人员明细；增购建议需显式勾选后才包含。</p>
              <div className="section-checks">
                {([
                  ['valueHighlights', '价值亮点'],
                  ['healthMatrix', '健康度矩阵'],
                  ['opportunities', '增购机会建议'],
                  ['appendix', '口径说明'],
                ] as Array<[keyof typeof sections, string]>).map(([key, label]) => (
                  <label key={key} className={sections[key] ? 'checked' : ''}>
                    <input type="checkbox" checked={sections[key]} onChange={() => toggleSection(key)} />
                    {label}
                  </label>
                ))}
              </div>
              <button className="primary" onClick={exportPdf} disabled={exporting}>
                {exporting ? '生成中…' : '确认并导出 PDF'}
              </button>
              {exportUrl && (
                <a className="download-link" href={exportUrl} target="_blank" rel="noreferrer">
                  下载报告 PDF
                </a>
              )}
            </section>

            <footer className="meta">
              规则版本 {report.ruleVersion} · 覆盖率 {Math.round(report.coverage * 100)}% · 生成于 {new Date(report.createdAt).toLocaleString()}
            </footer>
          </>
        )
      })()}

      {report && metrics && !v2 && (() => {
        // v0.1 旧快照兼容渲染
        const m = metrics as LegacyMetrics
        return (
          <>
            <section className="summary">
              <h2>客户价值摘要</h2>
              <textarea
                className="narrative-editor"
                value={narrativeDraft}
                onChange={e => setNarrativeDraft(e.target.value)}
                rows={3}
              />
              <button className="secondary" onClick={saveNarrative}>
                保存叙事（CSM 可编辑，指标不可改）
              </button>
            </section>
            <p className="legacy-note">此快照由旧规则版本（{report.ruleVersion}）生成，仅展示基础指标。</p>
            <section className="metrics-grid">
              <MetricCard title="项目" status={m.projects.status}>
                <div className="kv"><span className="kv-label">新建项目</span><span className="kv-value">{m.projects.newProjects}</span></div>
                <div className="kv"><span className="kv-label">活跃项目</span><span className="kv-value">{m.projects.activeProjects}</span></div>
              </MetricCard>
              <MetricCard title="Sprint" status={m.sprints.status}>
                <div className="kv"><span className="kv-label">终态</span><span className="kv-value">{m.sprints.finished}</span></div>
                <div className="kv"><span className="kv-label">按期完成</span><span className="kv-value">{m.sprints.onTimeFinished}</span></div>
              </MetricCard>
              <MetricCard title="工作项" status={m.issues.status}>
                <div className="kv"><span className="kv-label">创建</span><span className="kv-value">{m.issues.created}</span></div>
                <div className="kv"><span className="kv-label">首次完成</span><span className="kv-value">{m.issues.firstCompleted}</span></div>
                <div className="kv"><span className="kv-label">重开</span><span className="kv-value">{m.issues.reopened}</span></div>
              </MetricCard>
              <MetricCard title="交付周期" status={m.cycleTime.status}>
                <div className="kv"><span className="kv-label">P50</span><span className="kv-value">{m.cycleTime.p50Hours != null ? `${m.cycleTime.p50Hours} 小时` : '未知'}</span></div>
                <div className="kv"><span className="kv-label">P75</span><span className="kv-value">{m.cycleTime.p75Hours != null ? `${m.cycleTime.p75Hours} 小时` : '未知'}</span></div>
              </MetricCard>
              <MetricCard title="协作" status={m.collaboration.status}>
                <div className="kv"><span className="kv-label">人工变更</span><span className="kv-value">{m.collaboration.manualFieldChanges}</span></div>
                <div className="kv"><span className="kv-label">参与人数</span><span className="kv-value">{m.collaboration.participants}</span></div>
              </MetricCard>
              <MetricCard title="计划兑现" status={m.planFulfillment.status}>
                <div className="kv"><span className="kv-label">按期率</span><span className="kv-value">{m.planFulfillment.rate != null ? `${Math.round(m.planFulfillment.rate * 100)}%` : '样本不足'}</span></div>
              </MetricCard>
            </section>
            {throughputData.length > 0 && (
              <TrendChart data={throughputData} bars={['创建', '完成']} title="吞吐量趋势" />
            )}
            <footer className="meta">
              规则版本 {report.ruleVersion} · 覆盖率 {Math.round(report.coverage * 100)}% · 生成于 {new Date(report.createdAt).toLocaleString()}
            </footer>
          </>
        )
      })()}
    </div>
  )
}

const mount = () => {
  try {
    ReactDOM.render(<ReportPage />, document.getElementById('root'))
  } catch (error) {
    console.error('report page mount failed:', error)
    const root = document.getElementById('root')
    if (root) {
      root.innerHTML = `<pre style="color:#c00;padding:12px">页面挂载失败: ${String(error)}</pre>`
    }
  } finally {
    document.querySelector('.ones-app-loading')?.remove()
  }
}
mount()
