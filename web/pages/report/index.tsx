import { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { ONES } from '@ones-open/web-sdk'
import './index.css'

type TeamInfo = { teamUUID?: string; name?: string }
type UserInfo = { userUUID?: string; name?: string; email?: string }

type ConnectionState =
  | { phase: 'loading' }
  | { phase: 'ok'; team: TeamInfo; user: UserInfo; installation: { status?: string } }
  | { phase: 'error'; message: string }

const normalizeLocale = (locale?: string) => {
  const value = (locale || '').toLowerCase()
  return value.startsWith('zh') ? 'zh' : 'en'
}

const TEXT = {
  zh: {
    title: '客户价值与健康度',
    subtitle: '按周期生成不可变报告快照（M2 骨架，报告功能见 M3）',
    team: '当前团队',
    user: '当前用户',
    backend: '后端状态',
    backendOk: '已连接（生命周期回调正常）',
    loading: '加载中…',
    error: '加载失败',
  },
  en: {
    title: 'Customer Value & Health',
    subtitle: 'Generate immutable report snapshots per period (M2 skeleton, reporting in M3)',
    team: 'Current team',
    user: 'Current user',
    backend: 'Backend status',
    backendOk: 'Connected (lifecycle callbacks working)',
    loading: 'Loading…',
    error: 'Failed to load',
  },
}

const reportPage = () => {
  const [locale, setLocale] = useState<'zh' | 'en'>('zh')
  const [state, setState] = useState<ConnectionState>({ phase: 'loading' })

  useEffect(() => {
    const load = async () => {
      try {
        const [localeRaw, team, user] = await Promise.all([
          ONES.getLocale().catch(() => 'zh'),
          ONES.getTeamInfo(),
          ONES.getUserInfo(),
        ])
        setLocale(normalizeLocale(String(localeRaw)))
        const response = await ONES.fetchApp('/api/app-status')
        const installation = response.ok ? await response.json() : {}
        setState({
          phase: 'ok',
          team: { teamUUID: (team as { teamUUID?: string }).teamUUID, name: (team as { name?: string }).name },
          user: { userUUID: (user as { userUUID?: string }).userUUID, name: (user as { name?: string }).name },
          installation,
        })
      } catch (error) {
        setState({ phase: 'error', message: String((error as Error)?.message || error) })
      }
    }
    load()
  }, [])

  const t = TEXT[locale]

  return (
    <div className="report-page">
      <h1>{t.title}</h1>
      <p className="subtitle">{t.subtitle}</p>
      {state.phase === 'loading' && <p>{t.loading}</p>}
      {state.phase === 'error' && (
        <p className="error">
          {t.error}: {state.message}
        </p>
      )}
      {state.phase === 'ok' && (
        <dl className="status-list">
          <dt>{t.team}</dt>
          <dd>
            {state.team.name || '-'} ({state.team.teamUUID || '-'})
          </dd>
          <dt>{t.user}</dt>
          <dd>
            {state.user.name || '-'} ({state.user.userUUID || '-'})
          </dd>
          <dt>{t.backend}</dt>
          <dd>{t.backendOk}</dd>
        </dl>
      )}
    </div>
  )
}

ReactDOM.render(reportPage(), document.getElementById('root'))
