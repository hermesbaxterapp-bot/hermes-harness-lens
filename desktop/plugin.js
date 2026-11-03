// Harness Lens — how many times each Hermes session shelled out to a coding-agent
// harness (Claude Code, Codex, Antigravity agy, OpenCode, Copilot CLI, Gemini CLI,
// nested `hermes chat -q`). Read-only; data comes from this plugin's backend at
// /api/plugins/harness-lens/ which scans the profile's state.db.
import {
  Button,
  EmptyState,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Skeleton,
  host,
  useQuery
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'harness-lens'
const ROUTE = '/harness-lens'
const REST_TIMEOUT_MS = 60_000

const PERIODS = [
  { id: '7', label: '7d' },
  { id: '30', label: '30d' },
  { id: '90', label: '90d' },
  { id: '0', label: 'All' }
]
const SCOPES = [
  { id: '', label: 'This profile' },
  { id: 'all', label: 'All profiles' }
]

const COLUMNS = [
  { id: 'title', label: 'Session', sort: r => (r.title || r.id).toLowerCase() },
  { id: 'project', label: 'Project', sort: r => (r.project || '').toLowerCase() },
  { id: 'model', label: 'Model', sort: r => (r.model || '').toLowerCase() },
  { id: 'harnesses', label: 'Harnesses', sort: r => r.harnesses.join(',') },
  { id: 'invocations', label: 'Invokes', sort: r => r.invocations, numeric: true },
  { id: 'failed', label: 'Failed', sort: r => r.failed, numeric: true },
  { id: 'cost_usd', label: 'Session cost', sort: r => r.cost_usd ?? -1, numeric: true },
  { id: 'tokens', label: 'Tokens', sort: r => r.tokens || 0, numeric: true },
  { id: 'last_invocation_at', label: 'Last invoke', sort: r => r.last_invocation_at || 0, numeric: true }
]

const text1 = 'var(--ui-text-primary)'
const text2 = 'var(--ui-text-secondary)'
const text3 = 'var(--ui-text-tertiary)'
const stroke = 'var(--ui-stroke-secondary)'
const bg2 = 'var(--ui-bg-secondary)'
const accent = 'var(--ui-accent)'

function fmtNum(n) {
  if (n === null || n === undefined) return '—'
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
function fmtMoney(v, status) {
  if (v === null || v === undefined) return '—'
  const s = '$' + Number(v).toFixed(2)
  return status === 'estimated' ? '≈' + s : s
}
function fmtWhen(t) {
  if (!t) return '—'
  const d = new Date(t * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDur(s) {
  if (s === null || s === undefined) return '—'
  if (s < 60) return s.toFixed(0) + 's'
  if (s < 3600) return (s / 60).toFixed(1) + 'm'
  return (s / 3600).toFixed(1) + 'h'
}

// Free text plus `harness:codex project:chair model:opus source:desktop min:5 failed:yes`
function parseQuery(raw) {
  const terms = []
  const free = []
  const re = /(\w+):("[^"]*"|\S+)|(\S+)/g
  let m
  while ((m = re.exec(raw || ''))) {
    if (m[1]) terms.push([m[1].toLowerCase(), m[2].replace(/^"|"$/g, '').toLowerCase()])
    else free.push(m[3].toLowerCase())
  }
  return { terms, free: free.join(' ') }
}
function matches(row, q, harnessFilter) {
  if (harnessFilter && !(row.by_harness[harnessFilter] > 0)) return false
  for (const [k, v] of q.terms) {
    if (k === 'harness' && !row.harnesses.some(h => h.includes(v))) return false
    if (k === 'project' && !(row.project || '').toLowerCase().includes(v)) return false
    if (k === 'model' && !(row.model || '').toLowerCase().includes(v)) return false
    if (k === 'source' && !(row.source || '').toLowerCase().includes(v)) return false
    if (k === 'profile' && !(row.profile || '').toLowerCase().includes(v)) return false
    if (k === 'min' && !(row.invocations >= Number(v))) return false
    if (k === 'failed' && ((v === 'yes') !== row.failed > 0)) return false
    if (k === 'id' && !row.id.toLowerCase().includes(v)) return false
  }
  if (q.free) {
    const hay = `${row.title} ${row.project} ${row.model} ${row.id} ${row.cwd} ${row.harnesses.join(' ')}`.toLowerCase()
    if (!q.free.split(' ').every(w => hay.includes(w))) return false
  }
  return true
}

function toCsv(rows) {
  const cols = ['id', 'profile', 'title', 'project', 'model', 'source', 'harnesses', 'invocations', 'failed', 'cost_usd', 'tokens', 'first_invocation_at', 'last_invocation_at']
  const esc = v => {
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('|') : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')
}

function Pill({ label, count, active, onClick, title }) {
  return jsxs('button', {
    type: 'button',
    onClick,
    title,
    style: {
      border: `1px solid ${active ? accent : stroke}`,
      background: active ? 'color-mix(in srgb, var(--ui-accent) 18%, transparent)' : bg2,
      color: text1,
      borderRadius: '999px',
      padding: '0.1rem 0.55rem',
      fontSize: '0.72rem',
      cursor: onClick ? 'pointer' : 'default',
      whiteSpace: 'nowrap',
      display: 'inline-flex',
      gap: '0.35rem',
      alignItems: 'center'
    },
    children: [
      jsx('span', { children: label }),
      count !== undefined && jsx('span', { style: { color: text3, fontVariantNumeric: 'tabular-nums' }, children: count })
    ]
  })
}

function Invocations({ ctx, sessionId, scope, harnessLabels }) {
  const q = useQuery({
    queryKey: [PLUGIN_ID, 'invocations', sessionId, scope],
    queryFn: () => ctx.rest(`/sessions/${encodeURIComponent(sessionId)}/invocations${scope ? `?profiles=${scope}` : ''}`, { timeoutMs: REST_TIMEOUT_MS })
  })
  if (q.isLoading) return jsx('div', { style: { padding: '0.5rem 0.8rem' }, children: jsx(Skeleton, { className: 'h-4 w-64' }) })
  if (q.error) return jsx('div', { style: { padding: '0.5rem 0.8rem', color: text2 }, children: String(q.error?.message || q.error) })
  const rows = q.data?.invocations || []
  return jsx('table', {
    style: { width: '100%', borderCollapse: 'collapse', fontSize: '0.74rem' },
    children: jsx('tbody', {
      children: rows.map((inv, i) => jsxs('tr', {
        style: { borderTop: `1px solid ${stroke}` },
        children: [
          jsx('td', { style: { padding: '0.3rem 0.8rem', color: text3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }, children: fmtWhen(inv.timestamp) }),
          jsx('td', { style: { padding: '0.3rem 0.5rem', whiteSpace: 'nowrap' }, children: harnessLabels[inv.harness] || inv.harness }),
          jsx('td', {
            style: { padding: '0.3rem 0.5rem', whiteSpace: 'nowrap', color: inv.status === 'error' ? 'var(--ui-danger, #e5484d)' : inv.status === 'ok' ? 'var(--ui-success)' : text3 },
            title: inv.background ? 'Launched in the background: Hermes returned at once, the exit code is the launch, not the worker' : undefined,
            children: `${inv.status}${inv.exit_code !== null && inv.exit_code !== undefined ? ` (${inv.exit_code})` : ''}${inv.background ? ' · bg' : ''}`
          }),
          jsx('td', { style: { padding: '0.3rem 0.5rem', whiteSpace: 'nowrap', color: text3 }, children: inv.background ? '—' : fmtDur(inv.duration_seconds) }),
          jsx('td', { style: { padding: '0.3rem 0.5rem', color: text2, maxWidth: '18rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: inv.cwd, children: inv.cwd || '' }),
          jsx('td', {
            style: { padding: '0.3rem 0.8rem 0.3rem 0.5rem', fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)', color: text2, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
            children: inv.command
          })
        ]
      }, inv.tool_call_id + ':' + i))
    })
  })
}

function HarnessLensPage({ ctx }) {
  const [days, setDays] = useState('30')
  const [scope, setScope] = useState('')
  const [search, setSearch] = useState('')
  const [harnessFilter, setHarnessFilter] = useState('')
  const [sortId, setSortId] = useState('last_invocation_at')
  const [sortDir, setSortDir] = useState('desc')
  const [open, setOpen] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.resolve(ctx.storage.get('view')).then(v => {
      if (!alive || !v) return
      if (v.days) setDays(String(v.days))
      if (v.scope !== undefined) setScope(v.scope)
      if (v.sortId) setSortId(v.sortId)
      if (v.sortDir) setSortDir(v.sortDir)
    })
    return () => { alive = false }
  }, [])
  const persist = next => { void ctx.storage.set('view', { days, scope, sortId, sortDir, ...next }) }

  const query = useQuery({
    queryKey: [PLUGIN_ID, 'sessions', days, scope],
    queryFn: () => ctx.rest(`/sessions?days=${days}${scope ? `&profiles=${scope}` : ''}`, { timeoutMs: REST_TIMEOUT_MS }),
    placeholderData: previous => previous,
    refetchInterval: 60_000
  })

  const data = query.data
  const harnessLabels = useMemo(() => Object.fromEntries((data?.harnesses || []).map(h => [h.id, h.label])), [data])
  const parsed = useMemo(() => parseQuery(search), [search])
  const rows = useMemo(() => {
    const all = data?.sessions || []
    const filtered = all.filter(r => matches(r, parsed, harnessFilter))
    const col = COLUMNS.find(c => c.id === sortId) || COLUMNS[0]
    const dir = sortDir === 'asc' ? 1 : -1
    return filtered.slice().sort((a, b) => {
      const x = col.sort(a), y = col.sort(b)
      if (x < y) return -1 * dir
      if (x > y) return 1 * dir
      return 0
    })
  }, [data, parsed, harnessFilter, sortId, sortDir])

  const visibleTotals = useMemo(() => {
    const t = { invocations: 0, failed: 0, by: {} }
    for (const r of rows) {
      t.invocations += r.invocations
      t.failed += r.failed
      for (const [k, v] of Object.entries(r.by_harness)) t.by[k] = (t.by[k] || 0) + v
    }
    return t
  }, [rows])

  const clickSort = id => {
    if (sortId === id) {
      const d = sortDir === 'asc' ? 'desc' : 'asc'
      setSortDir(d); persist({ sortDir: d })
    } else {
      const col = COLUMNS.find(c => c.id === id)
      const d = col?.numeric ? 'desc' : 'asc'
      setSortId(id); setSortDir(d); persist({ sortId: id, sortDir: d })
    }
  }

  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(toCsv(rows))
      setCopied(true)
      ctx.setTimeout ? ctx.setTimeout(() => setCopied(false), 1500) : setTimeout(() => setCopied(false), 1500)
    } catch (e) { /* clipboard refused */ }
  }

  const header = jsxs('div', {
    style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', padding: '0.65rem 0.8rem', borderBottom: `1px solid ${stroke}` },
    children: [
      jsx('div', { style: { fontWeight: 600, color: text1, marginRight: '0.4rem' }, children: 'Harness Lens' }),
      jsx(SegmentedControl, { options: PERIODS, value: days, onChange: v => { const id = typeof v === 'string' ? v : v?.id; if (id === undefined) return; setDays(id); persist({ days: id }) } }),
      jsx(SegmentedControl, { options: SCOPES, value: scope, onChange: v => { const id = typeof v === 'string' ? v : v?.id; if (id === undefined) return; setScope(id); persist({ scope: id }) } }),
      jsx('div', {
        style: { flex: '1 1 16rem', minWidth: '12rem' },
        children: jsx(Input, {
          type: 'search',
          value: search,
          onChange: e => setSearch(e.target.value),
          placeholder: 'Search… try harness:codex project:chair min:5 failed:yes',
          title: 'Free text over title/project/model/id, or filters: harness: project: model: source: profile: id: min:N failed:yes|no'
        })
      }),
      jsx(Button, { variant: 'outline', size: 'xs', onClick: copyCsv, title: 'Copy the visible rows as CSV', children: copied ? 'Copied' : 'Copy CSV' }),
      jsx(Button, { variant: 'outline', size: 'xs', disabled: query.isFetching, onClick: () => query.refetch(), children: query.isFetching ? 'Refreshing…' : 'Refresh' })
    ]
  })

  const strip = data && jsxs('div', {
    style: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', padding: '0.5rem 0.8rem', borderBottom: `1px solid ${stroke}`, fontSize: '0.78rem', color: text2 },
    children: [
      jsx('span', { children: `${rows.length} session${rows.length === 1 ? '' : 's'} · ${visibleTotals.invocations} invoke${visibleTotals.invocations === 1 ? '' : 's'} · ${visibleTotals.failed} failed` }),
      jsx('span', { style: { color: text3 }, children: '·' }),
      ...(data.harnesses || []).filter(h => (data.totals.by_harness[h.id] || 0) > 0 || harnessFilter === h.id).map(h => jsx(Pill, {
        label: h.label,
        count: visibleTotals.by[h.id] || 0,
        active: harnessFilter === h.id,
        title: `Click to show only sessions that invoked ${h.label} (${h.binary})`,
        onClick: () => setHarnessFilter(harnessFilter === h.id ? '' : h.id)
      }, h.id)),
      jsx('span', { style: { flex: 1 } }),
      jsx('span', { style: { color: text3 }, title: data.method, children: `profiles: ${(data.profiles || []).join(', ')}` })
    ]
  })

  let body
  if (query.isLoading && !data) {
    body = jsx('div', { style: { padding: '1rem' }, children: jsx(Skeleton, { className: 'h-4 w-80' }) })
  } else if (query.error && !data) {
    body = jsx(EmptyState, { title: 'Could not read sessions', description: String(query.error?.message || query.error) })
  } else if (!rows.length) {
    body = jsx(EmptyState, { title: 'No harness invocations', description: search || harnessFilter ? 'Nothing matches the filter.' : 'No session in this period ran claude -p, codex exec, agy -p, opencode run, copilot -p, gemini -p or hermes chat -q through its terminal tool.' })
  } else {
    body = jsx('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
      children: [
        jsx('thead', {
          children: jsx('tr', {
            children: COLUMNS.map(c => jsx('th', {
              onClick: () => clickSort(c.id),
              style: { textAlign: c.numeric ? 'right' : 'left', padding: '0.45rem 0.6rem', color: sortId === c.id ? text1 : text3, fontWeight: 500, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', borderBottom: `1px solid ${stroke}`, position: 'sticky', top: 0, background: 'var(--ui-bg-primary, inherit)' },
              children: c.label + (sortId === c.id ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')
            }, c.id))
          })
        }, 'head'),
        jsx('tbody', {
          children: rows.flatMap(r => {
            const isOpen = open === r.id
            const main = jsxs('tr', {
              onClick: () => setOpen(isOpen ? null : r.id),
              style: { cursor: 'pointer', borderBottom: `1px solid ${stroke}`, background: isOpen ? bg2 : 'transparent' },
              children: [
                jsxs('td', {
                  style: { padding: '0.4rem 0.6rem', maxWidth: '26rem' },
                  children: [
                    jsx('div', { style: { color: text1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.title || r.id, children: r.title || r.id }),
                    jsx('div', { style: { color: text3, fontSize: '0.7rem' }, children: `${r.source}${scope ? ' · ' + r.profile : ''} · ${fmtWhen(r.started_at)}` })
                  ]
                }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', color: text2 }, title: r.cwd, children: r.project || '—' }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', color: text2, whiteSpace: 'nowrap' }, children: r.model || '—' }),
                jsx('td', {
                  style: { padding: '0.4rem 0.6rem' },
                  children: jsx('div', { style: { display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }, children: r.harnesses.map(h => jsx(Pill, { label: harnessLabels[h] || h, count: r.by_harness[h] }, h)) })
                }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', textAlign: 'right', color: text1, fontVariantNumeric: 'tabular-nums' }, children: r.invocations }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', textAlign: 'right', color: r.failed ? 'var(--ui-danger, #e5484d)' : text3, fontVariantNumeric: 'tabular-nums' }, children: r.failed }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', textAlign: 'right', color: text2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }, title: 'Cost of the Hermes session itself — the harness workers bill their own accounts', children: fmtMoney(r.cost_usd, r.cost_status) }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', textAlign: 'right', color: text2, fontVariantNumeric: 'tabular-nums' }, children: fmtNum(r.tokens) }),
                jsx('td', { style: { padding: '0.4rem 0.6rem', textAlign: 'right', color: text2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }, children: fmtWhen(r.last_invocation_at) })
              ]
            }, r.id)
            if (!isOpen) return [main]
            const detail = jsx('tr', {
              children: jsxs('td', {
                colSpan: COLUMNS.length,
                style: { padding: 0, background: bg2, borderBottom: `1px solid ${stroke}` },
                children: [
                  jsxs('div', {
                    style: { display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.8rem', fontSize: '0.74rem', color: text3 },
                    children: [
                      jsx('span', { children: r.id }),
                      jsx('span', { style: { flex: 1 } }),
                      jsx(Button, { variant: 'outline', size: 'xs', onClick: e => { e.stopPropagation(); host.openSession(r.id, { intent: 'stack' }) }, children: 'Open session' })
                    ]
                  }),
                  jsx(Invocations, { ctx, sessionId: r.id, scope, harnessLabels })
                ]
              })
            }, r.id + ':detail')
            return [main, detail]
          })
        }, 'body')
      ]
    })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: text1 },
    children: [
      header,
      strip,
      jsx('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 }, children: body })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Harness Lens',
  description: 'How many times each session shelled out to Claude Code, Codex, agy, OpenCode, Copilot, Gemini or a nested hermes chat.',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(HarnessLensPage, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 56, data: { path: ROUTE, label: 'Harness Lens', codicon: 'terminal' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'harness-lens.open',
          label: 'Harness Lens: coding-agent invocations per session',
          keywords: ['harness', 'claude code', 'codex', 'agy', 'antigravity', 'opencode', 'copilot', 'gemini', 'sessions', 'invocations'],
          run: () => host.navigate(ROUTE)
        }
      }
    ])
  }
}
