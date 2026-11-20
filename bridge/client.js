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
    // - 手机 / 浏览器经反代打开 → 页面是 http://<host>:7627，桥在 <host>:3088
    // - 桌面端是 dsh-app://app 这类自定义协议 → 页面根本不带 http 端口，只能直接打回环
    const BRIDGE_PORT_FALLBACK = 3088

    function candidateBases() {
      const bases = []
      const push = (base) => {
        if (!bases.includes(base)) bases.push(base)
      }
      const location = typeof window !== 'undefined' ? window.location : null
      const protocol = location?.protocol ?? ''
      if (protocol === 'http:' || protocol === 'https:') {
        push('')
        if (location.port !== String(BRIDGE_PORT_FALLBACK)) {
          push(`${protocol}//${location.hostname}:${BRIDGE_PORT_FALLBACK}`)
        }
      }
      push(`http://127.0.0.1:${BRIDGE_PORT_FALLBACK}`)
      push(`http://localhost:${BRIDGE_PORT_FALLBACK}`)
      return bases
    }

    /** 找到第一个能应答的桥地址（桌面端页面来源是 dsh-app://app，只能挨个试）。 */
    async function resolveBase() {
      const problems = []
      for (const base of candidateBases()) {
        const label = base === '' ? '同源' : base
        try {
          const response = await fetch(`${base}/health`, { cache: 'no-store' })
          if (response.ok) return { base, problems }
          problems.push(`${label} → HTTP ${response.status}`)
        } catch (error) {
          problems.push(`${label} → ${error?.message ?? error}`)
        }
      }
      return { base: '', problems }
    }

    /** 生成二维码前先体检：局域网、反代、隧道三段都通了才给码。 */
    async function runDiagnostics() {
      const resolved = await resolveBase()
      if (!resolved.base) return { ok: false, checks: [], error: resolved.problems.join('；') || '找不到桥服务' }
      try {
        const response = await fetch(`${resolved.base}/pair/test`, { cache: 'no-store' })
        if (!response.ok) {
          return { ok: false, checks: [], error: `体检接口 HTTP ${response.status}` }
        }
        const result = await response.json()
        return { ...result, base: resolved.base }
      } catch (error) {
        return { ok: false, checks: [], error: `体检失败：${error?.message ?? error}` }
      }
    }

    /** 体检通过后才取二维码。 */
    async function loadPairing(base) {
      try {
        const response = await fetch(`${base}/pair`, { cache: 'no-store' })
        if (!response.ok) return { error: `/pair → HTTP ${response.status}` }
        const info = await response.json()
        let svg = ''
        try {
          const svgResponse = await fetch(`${base}/pair.svg`, { cache: 'no-store' })
          if (svgResponse.ok) svg = await svgResponse.text()
        } catch {
          svg = ''
        }
        return { base, info, svg }
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
          const pair = await loadPairing(diag.base)
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
            src: `${diag.base}/pair.svg?ts=${Date.now()}`,
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
