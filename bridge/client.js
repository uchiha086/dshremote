window.__ModuleLoader__.load({
  id: 'dshremote-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 桥可能和页面不同源：页面走 7627（反代端口）时，桥在 3088。
    // 先按同源试，失败再退回 <host>:3088。
    const BRIDGE_PORT_FALLBACK = 3088
    let resolvedBase = null

    function candidateBases() {
      const bases = ['']
      if (typeof window !== 'undefined' && window.location) {
        const { protocol, hostname, port } = window.location
        if (port !== String(BRIDGE_PORT_FALLBACK)) {
          bases.push(`${protocol}//${hostname}:${BRIDGE_PORT_FALLBACK}`)
        }
      }
      return bases
    }

    async function bridgeFetch(path) {
      if (resolvedBase !== null) return fetch(`${resolvedBase}${path}`)
      for (const base of candidateBases()) {
        try {
          const response = await fetch(`${base}${path}`)
          if (response.ok && (response.headers.get('content-type') || '').includes('json')) {
            resolvedBase = base
            return response
          }
        } catch {
          // 换下一个候选
        }
      }
      throw new Error('bridge unreachable')
    }

    function qrSource() {
      const base = resolvedBase ?? ''
      return `${base}/pair.svg`
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
      const [info, setInfo] = React.useState(null)
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        if (!isOpen) return undefined
        let alive = true
        bridgeFetch('/pair')
          .then((response) => response.json())
          .then((data) => { if (alive) setInfo(data) })
          .catch(() => { if (alive) setInfo({ error: true }) })
        return () => { alive = false }
      }, [isOpen])

      if (!isOpen) return null

      const lan = info?.base ?? ''
      const wan = info?.public?.base ?? ''
      const payload = info?.payload ?? ''

      const copy = () => {
        const write = navigator.clipboard?.writeText?.(payload)
        Promise.resolve(write).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => setCopied(false))
      }

      return h('div', {
        onClick: () => setOpen(false),
        style: {
          position: 'fixed', inset: 0, zIndex: 800, display: 'flex',
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
        h('div', { style: { marginTop: 10, background: '#fff', display: 'flex', justifyContent: 'center' } },
          h('img', {
            src: qrSource(), width: 224, height: 224, alt: '配对二维码',
            style: { display: 'block', borderRadius: 8, background: '#fff' },
          }),
        ),
        h('div', { style: { marginTop: 12, fontSize: 12, color: '#4b5563' } },
          lan ? `局域网：${lan}` : '局域网：未就绪',
        ),
        h('div', { style: { marginTop: 2, fontSize: 12, color: '#4b5563' } },
          wan ? `公网：${wan}` : '公网：未设置（出门在外需要先起隧道）',
        ),
        h('div', { style: { marginTop: 14, display: 'flex', gap: 8 } },
          h('button', {
            type: 'button', onClick: copy,
            style: {
              flex: 1, padding: '9px 12px', borderRadius: 9, border: '1px solid #d1d5db',
              background: copied ? '#dcfce7' : '#f9fafb', color: '#111827',
              fontSize: 13, cursor: 'pointer',
            },
          }, copied ? '已复制' : '复制配对链接'),
          h('button', {
            type: 'button', onClick: () => window.open(qrSource(), '_blank'),
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
          resolvedBase = null
        })
      },
    }
  },
})
