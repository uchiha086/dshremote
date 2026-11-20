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

    /** 逐个候选地址试；返回 {base, info, svg} 或 {error}，把失败原因原样带回来便于在面板上显示。 */
    async function loadPairing() {
      const problems = []
      for (const base of candidateBases()) {
        const label = base === '' ? '同源' : base
        try {
          const response = await fetch(`${base}/pair`)
          if (!response.ok) {
            problems.push(`${label} → HTTP ${response.status}`)
            continue
          }
          const info = await response.json()
          let svg = ''
          try {
            const svgResponse = await fetch(`${base}/pair.svg`)
            if (svgResponse.ok) svg = await svgResponse.text()
            else problems.push(`${label} /pair.svg → HTTP ${svgResponse.status}`)
          } catch (error) {
            problems.push(`${label} /pair.svg → ${error?.message ?? error}`)
          }
          return { base, info, svg }
        } catch (error) {
          problems.push(`${label} → ${error?.message ?? error}`)
        }
      }
      return { error: problems.join('；') || 'unknown' }
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

    function PairOverlay() {
      const isOpen = useOpen()
      const [state, setState] = React.useState({ phase: 'idle' })
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        if (!isOpen) {
          setState({ phase: 'idle' })
          return undefined
        }
        let alive = true
        setState({ phase: 'loading' })
        loadPairing().then((result) => {
          if (!alive) return
          setState(result.error ? { phase: 'error', message: result.error } : { phase: 'ok', ...result })
        })
        return () => { alive = false }
      }, [isOpen])

      if (!isOpen) return null

      const info = state.phase === 'ok' ? state.info : null
      const svg = state.phase === 'ok' ? state.svg : ''
      const base = state.phase === 'ok' ? state.base : ''
      const lan = info?.base ?? ''
      const wan = info?.public?.base ?? ''
      const payload = info?.payload ?? ''
      const origin = typeof window !== 'undefined' ? window.location.origin : ''

      const copy = () => {
        const write = navigator.clipboard?.writeText?.(payload)
        Promise.resolve(write).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => setCopied(false))
      }

      const body = []
      if (state.phase === 'loading') {
        body.push(h('div', {
          key: 'loading',
          style: {
            width: 224, height: 224, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: '#6b7280', fontSize: 13,
          },
        }, '正在读取二维码…'))
      } else if (state.phase === 'error') {
        body.push(h('div', {
          key: 'error',
          style: {
            width: 224, minHeight: 120, display: 'flex', flexDirection: 'column',
            gap: 6, justifyContent: 'center', color: '#b91c1c', fontSize: 12,
            lineHeight: 1.5, wordBreak: 'break-all',
          },
        },
          h('div', null, '取二维码失败'),
          h('div', { style: { color: '#6b7280' } }, state.message),
          h('div', { style: { color: '#9ca3af' } }, `页面来源：${origin}`),
        ))
      } else if (svg) {
        body.push(h('img', {
          key: 'qr',
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          width: 224, height: 224, alt: '配对二维码',
          style: { display: 'block', borderRadius: 8, background: '#fff' },
        }))
      } else {
        // 拿不到 SVG 文本时退回让浏览器直接加载图片：<img> 不受 CORS 限制，只要能连通就能出图。
        body.push(h('img', {
          key: 'qr-img',
          src: `${base}/pair.svg?ts=${Date.now()}`,
          width: 224, height: 224, alt: '配对二维码',
          style: { display: 'block', borderRadius: 8, background: '#fff' },
        }))
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
          width: 340, maxWidth: '92vw', padding: 22, borderRadius: 16,
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
        h('div', { style: { marginTop: 10, background: '#fff', display: 'flex', justifyContent: 'center' } }, body),
        h('div', { style: { marginTop: 12, fontSize: 12, color: '#4b5563' } },
          lan ? `局域网：${lan}` : '局域网：未就绪',
        ),
        h('div', { style: { marginTop: 2, fontSize: 12, color: '#4b5563' } },
          wan ? `公网：${wan}` : '公网：未设置（出门在外需要先起隧道）',
        ),
        h('div', { style: { marginTop: 14, display: 'flex', gap: 8 } },
          h('button', {
            type: 'button', onClick: copy, disabled: !payload,
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: '1px solid #d1d5db',
              background: copied ? '#dcfce7' : '#f9fafb', color: '#111827',
              fontSize: 13, cursor: payload ? 'pointer' : 'default',
            },
          }, copied ? '已复制' : '复制配对链接'),
          h('button', {
            type: 'button',
            onClick: () => window.open(`${base}/pair.svg`, '_blank'),
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: 'none',
              background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer',
            },
          }, '单独打开'),
        ),
        h('div', { style: { marginTop: 10, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 } },
          '手机 App 首页 →「扫一扫」→ 对准屏幕。扫完自动填好地址与令牌，直接进入 DSH。',
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
