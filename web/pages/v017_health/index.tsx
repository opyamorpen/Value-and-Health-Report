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

type ValueMetrics = {
  projects: { newProjects: number; activeProjects: number; statusDistribution: Record<string, number>; status: string }
  sprints: { created: number; finished: number; onTimeFinished: number; status: string }
  issues: { created: number; firstCompleted: number; reopened: number; throughputTrend: Array<{ week: string; created: number; completed: number }>; status: string }
  cycleTime: { p50Hours: number | null; p75Hours: number | null; sampleSize: number; status: string }
  collaboration: { manualFieldChanges: number; participants: number; weeklyTrend: Array<{ week: string; actions: number; participants: number }>; status: string }
  planFulfillment: { total: number; onTime: number; rate: number | null; status: string }
}

type ReportData = {
  snapshotId: string
  metrics: ValueMetrics
  narrative: Record<string, string>
  coverage: number
  ruleVersion: string
  createdAt: number
}

/** 后端 metrics_json 兼容两种结构：旧平铺 / 新 {value, health} */
const normalizeReport = (report: ReportData): { report: ReportData; health: HealthMatrix | null } => {
  const metrics = report.metrics as unknown as Partial<ValueMetrics> & { value?: ValueMetrics; health?: HealthMatrix }
  if (metrics.value) {
    return { report: { ...report, metrics: metrics.value }, health: metrics.health ?? null }
  }
  return { report, health: null }
}

const STAGE_LABELS: Record<string, string> = {
  queued: '排队中',
  collecting_projects: '采集项目数据',
  collecting_sprints: '采集迭代数据',
  collecting_issues: '采集工作项',
  collecting_changelog: '采集变更记录',
  collecting_worklog: '采集工时',
  computing_metrics: '计算指标',
  saving_snapshot: '保存快照',
  done: '完成',
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString()

const maturityClass = (maturity: string): string => {
  if (maturity === '活跃使用' || maturity === '形成闭环') return 'active'
  if (maturity === '已配置未活跃') return 'configured'
  if (maturity === '未配置') return 'none'
  return 'bypass'
}

const MetricCard = ({ title, status, children }: { title: string; status: string; children: React.ReactNode }) => (
  <div className="metric-card">
    <div className="metric-head">
      <h3>{title}</h3>
      <span className={`status-badge status-${status}`}>{status === 'ok' ? '✓' : status === 'unknown' ? '?' : '!'}</span>
    </div>
    <div className="metric-body">{children}</div>
  </div>
)

const KV = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="kv">
    <span className="kv-label">{label}</span>
    <span className="kv-value">{value}</span>
  </div>
)

const ReportPage = () => {
  const [teamUuid, setTeamUuid] = useState('')
  const [userUuid, setUserUuid] = useState('')
  const [job, setJob] = useState<JobState | null>(null)
  const [report, setReport] = useState<ReportData | null>(null)
  const [snapshots, setSnapshots] = useState<Array<{ snapshotId: string; createdAt: number; coverage: number }>>([])
    const [message, setMessage] = useState('')
  const [sections, setSections] = useState({ valueHighlights: true, healthMatrix: false, opportunities: false, appendix: true })
  const [exporting, setExporting] = useState(false)
  const [exportUrl, setExportUrl] = useState('')
  const [health, setHealth] = useState<HealthMatrix | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const [team, user] = await Promise.all([ONES.getTeamInfo(), ONES.getUserInfo()])
        setTeamUuid((team as { teamUUID?: string }).teamUUID ?? '')
        setUserUuid((user as { uuid?: string }).uuid ?? (user as { userUUID?: string }).userUUID ?? '')
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

  const loadSnapshots = useCallback(async (team: string, user: string) => {
    if (!team || !user) return
    const resp = await ONES.fetchApp(
      `/api/snapshots?teamID=${encodeURIComponent(team)}&userID=${encodeURIComponent(user)}`,
    )
    if (resp.ok) {
      const data = (await resp.json()) as { snapshots?: typeof snapshots }
      setSnapshots(data.snapshots ?? [])
    }
  }, [])

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
              setHealth(normalized.health)
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
        setHealth(normalized.health)
      }
    }
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
  const throughputMax = useMemo(
    () => Math.max(1, ...(report?.metrics.issues.throughputTrend ?? []).map(t => Math.max(t.created, t.completed))),
    [report],
  )

  return (
    <div className="report-page">
      <header className="page-header">
        <h1>应用健康监测</h1>
        <p className="subtitle">各能力维度成熟度评估（未配置 / 已配置未活跃 / 活跃使用 / 形成闭环；未购买、不适用、无法核验为旁路状态）</p>
      </header>

      <section className="toolbar">
        <button className="primary" onClick={createJob} disabled={busy || !teamUuid}>
          {busy ? `生成中… ${job?.progress ?? 0}%（${STAGE_LABELS[job?.stage ?? ''] ?? job?.stage}）` : '生成报告快照'}
        </button>
        {busy && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${job?.progress ?? 0}%` }} />
          </div>
        )}
        {job?.status === 'partial' && <span className="warn">部分数据源失败（见证据页）</span>}
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

      {report && (
        <>
          {health && health.results.length > 0 && (
            <section className="health-section">
              <h2>应用健康度矩阵</h2>
              <div className="health-grid">
                {health.results.map(r => (
                  <div key={r.dimension} className={`health-item maturity-${maturityClass(r.maturity)}`}>
                    <div className="health-head">
                      <span className="health-dim">{r.dimension}</span>
                      <span className="maturity-badge">{r.maturity}</span>
                    </div>
                    {r.reason && <p className="health-reason">{r.reason}</p>}
                    {r.suggestion && <p className="health-suggestion">建议：{r.suggestion}</p>}
                  </div>
                ))}
              </div>
              {health.opportunities.length > 0 && (
                <div className="opportunities">
                  <h3>增购机会建议（未购模块，不计入健康度）</h3>
                  {health.opportunities.map(o => (
                    <div key={o.moduleKey} className="opportunity-item">
                      <strong>{o.moduleName}</strong>：{o.reason}
                      <span className="opp-evidence">（{o.evidence}）</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <footer className="meta">
            规则版本 {report.ruleVersion} · 覆盖率 {Math.round(report.coverage * 100)}% · 生成于 {new Date(report.createdAt).toLocaleString()}
          </footer>
        </>
      )}
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
