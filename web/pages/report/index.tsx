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

type ReportData = {
  snapshotId: string
  metrics: {
    projects: { newProjects: number; activeProjects: number; statusDistribution: Record<string, number>; status: string }
    sprints: { created: number; finished: number; onTimeFinished: number; status: string }
    issues: { created: number; firstCompleted: number; reopened: number; throughputTrend: Array<{ week: string; created: number; completed: number }>; status: string }
    cycleTime: { p50Hours: number | null; p75Hours: number | null; sampleSize: number; status: string }
    collaboration: { manualFieldChanges: number; participants: number; weeklyTrend: Array<{ week: string; actions: number; participants: number }>; status: string }
    planFulfillment: { total: number; onTime: number; rate: number | null; status: string }
  }
  narrative: Record<string, string>
  coverage: number
  ruleVersion: string
  createdAt: number
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
  const [narrativeDraft, setNarrativeDraft] = useState('')
  const [message, setMessage] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const [team, user] = await Promise.all([ONES.getTeamInfo(), ONES.getUserInfo()])
        setTeamUuid((team as { teamUUID?: string }).teamUUID ?? '')
        setUserUuid((user as { userUUID?: string }).userUUID ?? '')
      } catch (error) {
        setMessage(`上下文获取失败: ${String((error as Error).message)}`)
      }
    }
    init()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const loadSnapshots = useCallback(async (team: string) => {
    if (!team) return
    const resp = await ONES.fetchApp(`/api/snapshots?teamID=${encodeURIComponent(team)}`)
    if (resp.ok) {
      const data = (await resp.json()) as { snapshots?: typeof snapshots }
      setSnapshots(data.snapshots ?? [])
    }
  }, [])

  useEffect(() => {
    if (teamUuid) void loadSnapshots(teamUuid)
  }, [teamUuid, loadSnapshots])

  // 轮询任务进度
  useEffect(() => {
    if (!job || (job.status !== 'pending' && job.status !== 'running')) return
    const timer = setInterval(async () => {
      try {
        const resp = await ONES.fetchApp(`/api/report-jobs/${job.jobId}`)
        if (!resp.ok) return
        const data = (await resp.json()) as { job?: JobState }
        if (data.job) setJob(data.job)
        if (data.job && (data.job.status === 'succeeded' || data.job.status === 'partial') && data.job.snapshotKey) {
          const snapResp = await ONES.fetchApp(`/api/reports/${data.job.snapshotKey}`)
          if (snapResp.ok) {
            const snapData = (await snapResp.json()) as { report?: ReportData }
            if (snapData.report) {
              setReport(snapData.report)
              setNarrativeDraft(snapData.report.narrative?.summary ?? '')
            }
          }
          void loadSnapshots(teamUuid)
        }
      } catch {
        // 轮询失败忽略，下次重试
      }
    }, 2000)
    pollRef.current = timer
    return () => clearInterval(timer)
  }, [job, teamUuid, loadSnapshots])

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
    const resp = await ONES.fetchApp(`/api/reports/${snapshotId}`)
    if (resp.ok) {
      const data = (await resp.json()) as { report?: ReportData }
      if (data.report) {
        setReport(data.report)
        setNarrativeDraft(data.report.narrative?.summary ?? '')
      }
    }
  }

  const saveNarrative = async () => {
    if (!report) return
    const resp = await ONES.fetchApp(`/api/reports/${report.snapshotId}/narrative`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userID: userUuid, narrative: { ...report.narrative, summary: narrativeDraft } }),
    })
    const data = (await resp.json()) as { ok?: boolean }
    setMessage(data.ok ? '叙事已保存' : '保存失败')
  }

  const busy = job?.status === 'pending' || job?.status === 'running'
  const throughputMax = useMemo(
    () => Math.max(1, ...(report?.metrics.issues.throughputTrend ?? []).map(t => Math.max(t.created, t.completed))),
    [report],
  )

  return (
    <div className="report-page">
      <header className="page-header">
        <h1>客户价值与健康度</h1>
        <p className="subtitle">按周期生成不可变报告快照（默认近 90 天对比前 90 天）</p>
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

          <section className="metrics-grid">
            <MetricCard title="项目" status={report.metrics.projects.status}>
              <KV label="新建项目" value={report.metrics.projects.newProjects} />
              <KV label="活跃项目" value={report.metrics.projects.activeProjects} />
              <KV label="状态分布" value={JSON.stringify(report.metrics.projects.statusDistribution)} />
            </MetricCard>

            <MetricCard title="Sprint" status={report.metrics.sprints.status}>
              <KV label="新建" value={report.metrics.sprints.created} />
              <KV label="终态" value={report.metrics.sprints.finished} />
              <KV label="按期完成" value={report.metrics.sprints.onTimeFinished} />
            </MetricCard>

            <MetricCard title="工作项" status={report.metrics.issues.status}>
              <KV label="创建" value={report.metrics.issues.created} />
              <KV label="首次完成" value={report.metrics.issues.firstCompleted} />
              <KV label="重开" value={report.metrics.issues.reopened} />
            </MetricCard>

            <MetricCard title="交付周期" status={report.metrics.cycleTime.status}>
              <KV label="P50" value={report.metrics.cycleTime.p50Hours != null ? `${report.metrics.cycleTime.p50Hours} 小时` : '未知'} />
              <KV label="P75" value={report.metrics.cycleTime.p75Hours != null ? `${report.metrics.cycleTime.p75Hours} 小时` : '未知'} />
              <KV label="样本量" value={report.metrics.cycleTime.sampleSize} />
            </MetricCard>

            <MetricCard title="协作" status={report.metrics.collaboration.status}>
              <KV label="人工变更" value={report.metrics.collaboration.manualFieldChanges} />
              <KV label="参与人数" value={report.metrics.collaboration.participants} />
              <KV label="周趋势" value={`${report.metrics.collaboration.weeklyTrend.length} 周`} />
            </MetricCard>

            <MetricCard title="计划兑现" status={report.metrics.planFulfillment.status}>
              <KV label="有截止日期项" value={report.metrics.planFulfillment.total} />
              <KV label="按期完成" value={report.metrics.planFulfillment.onTime} />
              <KV label="按期率" value={report.metrics.planFulfillment.rate != null ? `${Math.round(report.metrics.planFulfillment.rate * 100)}%` : '样本不足'} />
            </MetricCard>
          </section>

          {report.metrics.issues.throughputTrend.length > 0 && (
            <section className="chart">
              <h2>吞吐量趋势</h2>
              <div className="trend-chart">
                {report.metrics.issues.throughputTrend.map(t => (
                  <div key={t.week} className="trend-col" title={`${t.week}：创建 ${t.created} / 完成 ${t.completed}`}>
                    <div className="trend-bars">
                      <div className="bar created" style={{ height: `${(t.created / throughputMax) * 100}%` }} />
                      <div className="bar completed" style={{ height: `${(t.completed / throughputMax) * 100}%` }} />
                    </div>
                    <span className="trend-label">{t.week.slice(5)}</span>
                  </div>
                ))}
              </div>
              <div className="legend">
                <span className="dot created" /> 创建 <span className="dot completed" /> 完成
              </div>
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
