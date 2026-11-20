window.__ModuleLoader__.load({
  id: 'dshremote-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 浮层用 portal 挂到 body，避免被侧栏/布局里带 transform 或 overflow 的祖先裁掉。
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal
    } catch {
      // 拿不到 react-dom 就退回就地渲染
    }

    // 桥可能和页面不同源：
    // - 桌面端是 dsh-app://app 这类自定义协议 → 从页面直接打 http://127.0.0.1:3088
    //   会被浏览器的私有网络访问策略拦成 "Failed to fetch"，所以优先走 DSH
    //   自己 web 服务上挂的同源路由（/dshremote/*）。
    // - 手机 / 浏览器经反代打开 → 页面是 http://<host>:7627，同源路由同样在。
    const BRIDGE_PORT_FALLBACK = 3088
    const SAME_ORIGIN_PREFIX = '/dshremote'

    function candidateBases() {
      const candidates = []
      const push = (base, prefix) => {
        const key = `${base}|${prefix}`
        if (candidates.some((item) => `${item.base}|${item.prefix}` === key)) return
        candidates.push({ base, prefix })
      }
      push('', SAME_ORIGIN_PREFIX)
      push(`http://127.0.0.1:${BRIDGE_PORT_FALLBACK}`, '')
      push(`http://localhost:${BRIDGE_PORT_FALLBACK}`, '')
      return candidates
    }

    /** 找到第一个能应答的桥地址（桌面端页面来源是 dsh-app://app，只能挨个试）。 */
    async function resolveBase() {
      const problems = []
      for (const candidate of candidateBases()) {
        const label = candidate.base === '' ? `同源 ${candidate.prefix}` : candidate.base
        try {
          const response = await fetch(`${candidate.base}${candidate.prefix}/health`, { cache: 'no-store' })
          if (response.ok) return { base: candidate.base, prefix: candidate.prefix, problems }
          problems.push(`${label} → HTTP ${response.status}`)
        } catch (error) {
          problems.push(`${label} → ${error?.message ?? error}`)
        }
      }
      return { base: '', prefix: '', problems }
    }

    /** 生成二维码前先体检：局域网、反代、隧道三段都通了才给码。 */
    async function runDiagnostics() {
      const resolved = await resolveBase()
      if (!resolved.base && !resolved.prefix) {
        return { ok: false, checks: [], error: resolved.problems.join('；') || '找不到桥服务' }
      }
      const root = `${resolved.base}${resolved.prefix}`
      try {
        const response = await fetch(`${root}/pair/test`, { cache: 'no-store' })
        if (!response.ok) {
          return { ok: false, checks: [], error: `体检接口 HTTP ${response.status}` }
        }
        const result = await response.json()
        return { ...result, base: resolved.base, prefix: resolved.prefix }
      } catch (error) {
        return { ok: false, checks: [], error: `体检失败：${error?.message ?? error}` }
      }
    }

    /** 体检通过后才取二维码。 */
    async function loadPairing(root) {
      try {
        const response = await fetch(`${root}/pair`, { cache: 'no-store' })
        if (!response.ok) return { error: `/pair → HTTP ${response.status}` }
        const info = await response.json()
        let svg = ''
        try {
          const svgResponse = await fetch(`${root}/pair.svg`, { cache: 'no-store' })
          if (svgResponse.ok) svg = await svgResponse.text()
        } catch {
          svg = ''
        }
        return { root, info, svg }
      } catch (error) {
        return { error: `/pair → ${error?.message ?? error}` }
      }
    }

    // 面板开关状态：侧栏按钮和浮层两个槽位共享。
    const listeners = new Set()
    let open = false
    function setOpen(next) {
      open = next
      for (const listener of listeners) listener(open)
    }
    function useOpen() {
      const [value, setValue] = React.useState(open)
      React.useEffect(() => {
        const listener = (next) => setValue(next)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return value
    }

    function QrIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true,
      },
        h('rect', { x: 1.5, y: 1.5, width: 5, height: 5, rx: 1 }),
        h('rect', { x: 9.5, y: 1.5, width: 5, height: 5, rx: 1 }),
        h('rect', { x: 1.5, y: 9.5, width: 5, height: 5, rx: 1 }),
        h('path', { d: 'M9.5 9.5h2v2h-2zM12.5 12.5h2v2h-2z', strokeWidth: 1.2 }),
      )
    }

    function PairButton() {
      const isOpen = useOpen()
      return h('button', {
        type: 'button',
        title: 'DSH Remote：手机扫码连接',
        'aria-label': 'DSH Remote',
        'aria-pressed': isOpen,
        onClick: () => setOpen(!open),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, padding: 0, border: 'none', borderRadius: 8,
          background: isOpen ? 'rgba(90,145,255,0.16)' : 'transparent',
          color: 'inherit', cursor: 'pointer', opacity: isOpen ? 1 : 0.72,
        },
      }, h(QrIcon, { size: 17 }))
    }

    const CHECK_HINTS = ['桥服务', 'DSH 反代', '局域网可达', '隧道 → 桥', '隧道 → DSH']

    function CheckRow({ name, ok, ms, detail }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0',
          fontSize: 12, lineHeight: 1.45,
        },
      },
        h('span', {
          style: {
            flex: 'none', width: 14, textAlign: 'center',
            color: ok === undefined ? '#9ca3af' : ok ? '#16a34a' : '#dc2626',
            fontWeight: 700,
          },
        }, ok === undefined ? '·' : ok ? '✓' : '✗'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('span', { style: { color: '#111827' } }, name),
          typeof ms === 'number' && ms > 0 ? h('span', { style: { color: '#9ca3af' } }, ` · ${ms}ms`) : null,
          detail ? h('div', { style: { color: '#6b7280', wordBreak: 'break-all' } }, detail) : null,
        ),
      )
    }

    function PairOverlay() {
      const isOpen = useOpen()
      const [state, setState] = React.useState({ phase: 'idle' })
      const [copied, setCopied] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        if (!isOpen) {
          setState({ phase: 'idle' })
          return undefined
        }
        let alive = true
        setState({ phase: 'testing' })
        runDiagnostics().then(async (diag) => {
          if (!alive) return
          if (!diag.ok) {
            setState({ phase: 'failed', diag })
            return
          }
          const pair = await loadPairing(`${diag.base}${diag.prefix ?? ''}`)
          if (!alive) return
          if (pair.error) {
            setState({ phase: 'failed', diag, error: pair.error })
            return
          }
          setState({ phase: 'ready', diag, pair })
        })
        return () => { alive = false }
      }, [isOpen, attempt])

      if (!isOpen) return null

      const diag = state.diag ?? null
      const checks = diag?.checks ?? []
      const pair = state.phase === 'ready' ? state.pair : null
      const payload = pair?.info?.payload ?? ''
      const lan = diag?.lan ?? ''
      const tunnel = diag?.tunnel ?? ''
      const origin = typeof window !== 'undefined' ? window.location.origin : ''

      const rootOf = (value) => `${value?.base ?? ''}${value?.prefix ?? ''}`

      // 一键修复：重拉隧道并等到公网可用，再自动重跑体检。
      const repair = async () => {
        setBusy('repair')
        setNotice({ ok: true, text: '正在重拉隧道，最多等 2 分钟…' })
        try {
          const response = await fetch(`${rootOf(diag)}/repair`, { cache: 'no-store' })
          const result = await response.json()
          if (result.ok) {
            setNotice({ ok: true, text: `隧道已恢复：${result.tunnel}（${Math.round((result.waitedMs ?? 0) / 1000)}s）` })
          } else {
            setNotice({ ok: false, text: `没修好：${result.error ?? '未知原因'}，可以点「让 AI 修」` })
          }
        } catch (error) {
          setNotice({ ok: false, text: `修复请求失败：${error?.message ?? error}` })
        } finally {
          setBusy('')
          setAttempt((value) => value + 1)
        }
      }

      // 让 AI 修：让桥在 DSH 里开一个新会话，把体检结果直接发过去。
      const aiFix = async () => {
        setBusy('ai')
        setNotice({ ok: true, text: '正在新开一个修复会话…' })
        try {
          const response = await fetch(`${rootOf(diag)}/ai-fix`, { cache: 'no-store' })
          const result = await response.json()
          if (result.ok) {
            setNotice({ ok: true, text: '已在新会话里开始修复，切到会话列表看最新那条。' })
          } else {
            setNotice({ ok: false, text: `AI 会话没起来：${result.error ?? '未知原因'}` })
          }
        } catch (error) {
          setNotice({ ok: false, text: `请求失败：${error?.message ?? error}` })
        } finally {
          setBusy('')
        }
      }

      const copy = () => {
        const write = navigator.clipboard?.writeText?.(payload)
        Promise.resolve(write).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => setCopied(false))
      }

      const rows = []
      if (state.phase === 'testing') {
        for (const name of CHECK_HINTS) rows.push(h(CheckRow, { key: name, name, ok: undefined, ms: 0, detail: '检测中…' }))
      } else {
        for (const check of checks) rows.push(h(CheckRow, { key: check.name, ...check }))
      }
      if (diag?.error) rows.push(h('div', { key: 'diag-error', style: { color: '#b91c1c', fontSize: 12, marginTop: 6, wordBreak: 'break-all' } }, diag.error))
      if (state.error) rows.push(h('div', { key: 'pair-error', style: { color: '#b91c1c', fontSize: 12, marginTop: 6, wordBreak: 'break-all' } }, state.error))

      const qrBox = []
      if (state.phase === 'ready') {
        if (pair.svg) {
          qrBox.push(h('img', {
            key: 'qr',
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pair.svg)}`,
            width: 216, height: 216, alt: '配对二维码',
            style: { display: 'block', borderRadius: 8, background: '#fff' },
          }))
        } else {
          qrBox.push(h('img', {
            key: 'qr-img',
            src: `${diag.base}${diag.prefix ?? ''}/pair.svg?ts=${Date.now()}`,
            width: 216, height: 216, alt: '配对二维码',
            style: { display: 'block', borderRadius: 8, background: '#fff' },
          }))
        }
      } else if (state.phase === 'testing') {
        qrBox.push(h('div', {
          key: 'qr-loading',
          style: {
            width: 216, height: 216, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#6b7280', fontSize: 13, border: '1px dashed #d1d5db', borderRadius: 12,
          },
        }, '正在测试环境…'))
      } else {
        qrBox.push(h('div', {
          key: 'qr-blocked',
          style: {
            width: 216, minHeight: 96, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#b91c1c', fontSize: 12, textAlign: 'center', lineHeight: 1.5,
            border: '1px dashed #fca5a5', borderRadius: 12, padding: 12, boxSizing: 'border-box',
          },
        }, '环境没通过测试，先不出码'))
      }

      const panel = h('div', {
        onClick: () => setOpen(false),
        style: {
          position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(8,12,22,0.55)', pointerEvents: 'auto',
        },
      }, h('div', {
        onClick: (event) => event.stopPropagation(),
        style: {
          width: 356, maxWidth: '93vw', padding: 22, borderRadius: 16,
          background: '#ffffff', color: '#111827',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)', fontFamily: 'inherit',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '手机遥控 DSH'),
          h('button', {
            type: 'button', onClick: () => setOpen(false),
            style: {
              border: 'none', background: 'transparent', color: '#6b7280',
              fontSize: 18, cursor: 'pointer', lineHeight: 1,
            },
          }, '×'),
        ),
        h('div', {
          style: {
            marginTop: 12, padding: '10px 12px', borderRadius: 10,
            background: '#f8fafc', border: '1px solid #e5e7eb',
          },
        }, rows),
        h('div', { style: { marginTop: 14, display: 'flex', justifyContent: 'center' } }, qrBox),
        state.phase === 'ready'
          ? h('div', { style: { marginTop: 10, fontSize: 12, color: '#4b5563', textAlign: 'center' } },
            tunnel ? `手机扫码即可（同一 Wi-Fi 直连，出门走隧道）` : '手机扫码即可（仅同一 Wi-Fi 可用）')
          : null,
        state.phase === 'ready'
          ? h('div', { style: { marginTop: 4, fontSize: 11, color: '#9ca3af', textAlign: 'center', wordBreak: 'break-all' } },
            [lan, tunnel].filter(Boolean).join('  |  '))
          : h('div', { style: { marginTop: 4, fontSize: 11, color: '#9ca3af', textAlign: 'center' } },
            `页面来源：${origin}`),
        h('div', { style: { marginTop: 14, display: 'flex', gap: 8 } },
          h('button', {
            type: 'button',
            onClick: () => setAttempt((value) => value + 1),
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: '1px solid #d1d5db',
              background: '#f9fafb', color: '#111827', fontSize: 13, cursor: 'pointer',
            },
          }, '重新测试'),
          h('button', {
            type: 'button', onClick: copy, disabled: !payload,
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: 'none',
              background: payload ? '#2563eb' : '#c7d2fe', color: '#fff',
              fontSize: 13, cursor: payload ? 'pointer' : 'default',
            },
          }, copied ? '已复制' : '复制配对链接'),
        ),
        h('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
          h('button', {
            type: 'button', onClick: repair, disabled: busy !== '',
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: 'none',
              background: '#10b981',
              color: '#fff', fontSize: 13, cursor: busy === '' ? 'pointer' : 'default',
              opacity: busy !== '' && busy !== 'repair' ? 0.6 : 1,
            },
          }, busy === 'repair' ? '正在修复…' : '一键修复'),
          h('button', {
            type: 'button', onClick: aiFix, disabled: busy !== '',
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: '1px solid #c7d2fe',
              background: '#eef2ff', color: '#3730a3', fontSize: 13,
              cursor: busy === '' ? 'pointer' : 'default',
              opacity: busy !== '' && busy !== 'ai' ? 0.6 : 1,
            },
          }, busy === 'ai' ? '正在叫 AI…' : '让 AI 修'),
        ),
        notice
          ? h('div', {
            style: {
              marginTop: 8, fontSize: 11, lineHeight: 1.5, wordBreak: 'break-all',
              color: notice.ok ? '#047857' : '#b45309',
            },
          }, notice.text)
          : null,
        h('div', { style: { marginTop: 10, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 } },
          '一键修复会重拉隧道并等到公网可用；让 AI 修会在 DSH 里开一个新会话，把体检结果交给它处理。',
        ),
        h('div', { style: { marginTop: 10, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 } },
          '手机 App：没连接过会自动进入扫码页，扫完直接进 DSH；右上角只有设置入口。',
        ),
      ))

      const canPortal = createPortal !== null && typeof document !== 'undefined' && document.body
      return canPortal ? createPortal(panel, document.body) : panel
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dshremote-pair',
          order: 40,
        }, PairButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dshremote-pair-overlay',
        }, PairOverlay))

        ctx.effect(() => () => {
          listeners.clear()
        })
      },
    }
  },
})
