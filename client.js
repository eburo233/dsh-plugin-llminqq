/**
 * dsh-plugin-llminqq — 设置页（Client 半边）。
 *
 * 按 dsh.client bundle 格式加载：注册一个 settings.section「QQ 通道」，
 * 里面是这套东西的完整图形界面。
 *
 * 为什么全部逻辑放在一个文件里：
 *   client bundle 走 window.__ModuleLoader__.load({factory}) 加载，没有打包步骤，
 *   拆成多个文件需要自己搞 require 路径映射，收益不抵成本。这个文件按「节」分块，
 *   每块一个组件，找起来并不难。
 *
 * 数据全部走 /dsh-plugin-llminqq/api/*（server 侧注册的 HTTP 路由）。
 * 前端不直接读写文件 —— 那样既绕过了服务端的校验，也没法在浏览器沙箱里跑。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-llminqq',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const API = '/dsh-plugin-llminqq/api'

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 用宿主的 CSS 变量（--dsw-alias-*），这样深浅色主题自动跟随。
    // 不自己定义颜色 —— 硬编码颜色在暗色主题下会变成「白底白字」。
    const CSS = `
/* ── 设计令牌：只用宿主的语义变量，深浅色主题自动跟随 ─────────────────────── */
.qq-panel{
  --qq-line:var(--dsw-alias-border-l1);
  --qq-hair:.5px solid var(--dsw-alias-border-l1);
  --qq-surface:var(--dsw-alias-bg-layer-1);
  --qq-sunken:var(--dsw-alias-bg-layer-2);
  --qq-1:var(--dsw-alias-label-primary);
  --qq-2:var(--dsw-alias-label-secondary);
  --qq-3:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-caption,#81858c));
  --qq-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));
  --qq-ok:var(--dsw-alias-state-success-primary,#0a7f3f);
  --qq-warn:var(--dsw-alias-state-warn-primary,#a45c00);
  --qq-bad:var(--dsw-alias-state-error-primary,#c4292e);
  --qq-r:var(--dsw-radius-md,12px);--qq-r-sm:var(--dsw-radius-sm,8px);
  display:flex;flex-direction:column;gap:16px;padding:2px 0;max-width:760px;
  font-size:13px;line-height:1.55;color:var(--qq-1);-webkit-font-smoothing:antialiased}
.qq-panel,.qq-panel *{box-sizing:border-box}
.qq-panel a{color:var(--qq-brand);text-decoration:none}
.qq-panel a:hover{text-decoration:underline}
.qq-panel code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.94em;
  padding:1px 5px;border-radius:5px;background:var(--qq-sunken);border:var(--qq-hair)}
.qq-panel ol,.qq-panel ul{margin:0;padding-left:18px;line-height:1.75}
.qq-panel li+li{margin-top:2px}

/* ── 文字 ─────────────────────────────────────────────────────────────── */
.qq-panel .hint{font-size:12px;line-height:1.6;color:var(--qq-2)}
.qq-panel .muted{font-size:11.5px;color:var(--qq-3)}
.qq-panel .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* ── 分节标题（比卡片标题更轻，用来分组）──────────────────────────────── */
.qq-panel .sec-head{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--qq-3);padding:0 2px}

/* ── 卡片 ─────────────────────────────────────────────────────────────── */
.qq-panel .card{border:var(--qq-hair);border-radius:var(--qq-r);background:var(--qq-surface);
  padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.qq-panel .card-title{font-size:13px;font-weight:600;margin:0;display:flex;align-items:center;
  gap:8px;flex-wrap:wrap;line-height:1.5}
.qq-panel .card-title .hint{font-weight:400;font-size:12px}
.qq-panel .card-title>.right{margin-left:auto;display:flex;align-items:center;gap:8px}
.qq-panel .divider{height:.5px;background:var(--qq-line);border:0;margin:2px 0}

/* ── 行 / 开关行（设置页的骨架：整行可读，细线分隔）────────────────────── */
.qq-panel .rows{display:flex;flex-direction:column}
.qq-panel .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.qq-panel .switchrow{display:flex;align-items:center;gap:14px;padding:9px 0;min-height:38px}
.qq-panel .card>*+.switchrow{border-top:var(--qq-hair)}
.qq-panel .card>.rows>.switchrow+.switchrow{border-top:var(--qq-hair)}
.qq-panel .switchrow .lbl{flex:1;min-width:0;font-size:13px;line-height:1.45}
.qq-panel .switchrow .dsc{font-size:11.5px;color:var(--qq-2);margin-top:1px;line-height:1.5}
.qq-panel .switchgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
.qq-panel .switchgrid .switchrow{border-top:0!important;padding:7px 0}

/* ── 字段 ─────────────────────────────────────────────────────────────── */
.qq-panel .field{display:flex;flex-direction:column;gap:6px;min-width:0}
.qq-panel .field>label{font-size:12.5px;font-weight:500;color:var(--qq-1)}
.qq-panel .field .sub{font-size:11.5px;color:var(--qq-3);line-height:1.5}
.qq-panel .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.qq-panel .grid2.tight{gap:8px 12px}
@media (max-width:640px){.qq-panel .grid2,.qq-panel .switchgrid{grid-template-columns:1fr}}

/* ── 表单控件 ─────────────────────────────────────────────────────────── */
.qq-panel input[type=text],.qq-panel input[type=number],.qq-panel input[type=password],.qq-panel select,.qq-panel textarea{
  width:100%;min-height:32px;font:inherit;font-size:13px;line-height:1.5;color:var(--qq-1);
  background:var(--qq-sunken);border:var(--qq-hair);border-radius:var(--qq-r-sm);
  padding:6px 10px;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.qq-panel input::placeholder,.qq-panel textarea::placeholder{color:var(--qq-3)}
.qq-panel :is(input,select,textarea):focus{border-color:var(--qq-brand);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--qq-brand) 15%,transparent)}
.qq-panel textarea{resize:vertical;min-height:84px;line-height:1.6}
.qq-panel select{cursor:pointer;padding-right:28px}
.qq-panel button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;
  font:inherit;font-size:13px;color:var(--qq-1);background:var(--qq-sunken);border:var(--qq-hair);
  border-radius:var(--qq-r-sm);padding:0 13px;cursor:pointer;white-space:nowrap;
  transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.qq-panel button:hover:not(:disabled){border-color:var(--qq-brand);
  background:var(--dsw-alias-interactive-bg-hover,var(--qq-sunken))}
.qq-panel button:disabled{opacity:.45;cursor:not-allowed}
.qq-panel button.primary{background:var(--qq-brand);border-color:var(--qq-brand);
  color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:500}
.qq-panel button.primary:hover:not(:disabled){opacity:.92;background:var(--qq-brand)}
.qq-panel button.danger{color:var(--qq-bad);border-color:color-mix(in srgb,var(--qq-bad) 35%,transparent)}
.qq-panel button.danger:hover:not(:disabled){color:var(--qq-bad);border-color:var(--qq-bad);
  background:color-mix(in srgb,var(--qq-bad) 9%,transparent)}
.qq-panel button.ghost{background:none;border-color:transparent;color:var(--qq-2);padding:0 9px}
.qq-panel button.ghost:hover:not(:disabled){background:var(--qq-sunken);color:var(--qq-1);border-color:transparent}
.qq-panel button.tiny{min-height:26px;padding:0 9px;font-size:12px;border-radius:6px}

/* ── 开关 ─────────────────────────────────────────────────────────────── */
.qq-panel .switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;
  background:color-mix(in srgb,var(--qq-2) 28%,transparent);cursor:pointer;
  transition:background .16s ease}
.qq-panel .switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .16s cubic-bezier(.3,.9,.3,1)}
.qq-panel .switch.on{background:var(--qq-brand)}
.qq-panel .switch.on::after{transform:translateX(16px)}

/* ── 徽标（圆点 + 文字，颜色由 kind 决定）──────────────────────────────── */
.qq-panel .badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;
  line-height:18px;padding:1px 9px;border-radius:999px;border:1px solid var(--qq-line);
  background:var(--qq-sunken);color:var(--qq-2)}
.qq-panel .badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.qq-panel .badge.ok{color:var(--qq-ok);border-color:color-mix(in srgb,var(--qq-ok) 35%,transparent);
  background:color-mix(in srgb,var(--qq-ok) 9%,transparent)}
.qq-panel .badge.warn{color:var(--qq-warn);border-color:color-mix(in srgb,var(--qq-warn) 35%,transparent);
  background:color-mix(in srgb,var(--qq-warn) 9%,transparent)}
.qq-panel .badge.bad{color:var(--qq-bad);border-color:color-mix(in srgb,var(--qq-bad) 35%,transparent);
  background:color-mix(in srgb,var(--qq-bad) 9%,transparent)}

/* ── 提示条 ───────────────────────────────────────────────────────────── */
.qq-panel .notice{padding:10px 12px;border-radius:var(--qq-r-sm);font-size:12.5px;line-height:1.65;
  background:var(--qq-sunken);border:var(--qq-hair);color:var(--qq-1)}
.qq-panel .notice .notice-title{font-weight:600;margin-bottom:3px}
.qq-panel .notice.ok{background:color-mix(in srgb,var(--qq-ok) 8%,transparent);
  border-color:color-mix(in srgb,var(--qq-ok) 30%,transparent)}
.qq-panel .notice.ok .notice-title{color:var(--qq-ok)}
.qq-panel .notice.warn{background:color-mix(in srgb,var(--qq-warn) 9%,transparent);
  border-color:color-mix(in srgb,var(--qq-warn) 32%,transparent)}
.qq-panel .notice.warn .notice-title{color:var(--qq-warn)}
.qq-panel .notice.err{background:color-mix(in srgb,var(--qq-bad) 8%,transparent);
  border-color:color-mix(in srgb,var(--qq-bad) 32%,transparent)}
.qq-panel .notice.err .notice-title{color:var(--qq-bad)}

/* ── 键值表（体检结果这类「标签 : 值」）───────────────────────────────── */
.qq-panel .kv{display:grid;grid-template-columns:104px minmax(0,1fr) auto;gap:7px 12px;
  align-items:baseline;font-size:12.5px;margin:0}
.qq-panel .kv>dt{color:var(--qq-2);white-space:nowrap}
.qq-panel .kv>dd{margin:0;min-width:0;word-break:break-word;color:var(--qq-1)}
.qq-panel .kv>dd.flag{font-size:11.5px;color:var(--qq-3);text-align:right;white-space:nowrap}
.qq-panel .kv>dd.flag.ok{color:var(--qq-ok)}

/* ── 代码块（带复制按钮）────────────────────────────────────────────── */
.qq-panel .codewrap{position:relative}
.qq-panel .codewrap>.copybtn{position:absolute;top:6px;right:6px;min-height:24px;padding:0 8px;
  font-size:11px;background:var(--qq-surface)}
.qq-panel .code{margin:0;padding:10px 12px;border-radius:var(--qq-r-sm);border:var(--qq-hair);
  background:var(--qq-sunken);color:var(--qq-1);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.65;
  white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto}

/* ── 折叠块（native details：不占 React state，键盘也能用）────────────── */
/* ⚠️ 必须显式覆盖宿主那条 .collapse{visibility:collapse} ——
   它是一条**全局内联规则**（不属于我们插件），把任何 class 含 collapse 的元素
   变成「占位但不可见」：DOM 在、高度 41px 在、颜色也正常，就是看不见。
   表现就是「这一块明明是空的但还占地方」。
   只加 .qq-panel .qq-collapse 还不够（同优先级下后者看源码顺序，宿主在内联层之后注入），
   所以这里用 visibility:visible + !important 钉死。 */
.qq-panel .qq-collapse,
.qq-panel .qq-collapse:not([open]),
.qq-panel details.qq-collapse {
  visibility:visible!important;
}
.qq-panel .qq-collapse{border:var(--qq-hair);border-radius:var(--qq-r-sm);background:var(--qq-surface)}
.qq-panel .qq-collapse+.qq-collapse{margin-top:8px}
.qq-panel .qq-collapse>summary{list-style:none;cursor:pointer;user-select:none;padding:9px 12px;
  font-size:12.5px;color:var(--qq-2);display:flex;align-items:center;gap:8px;border-radius:var(--qq-r-sm)}
.qq-panel .qq-collapse>summary::-webkit-details-marker{display:none}
.qq-panel .qq-collapse>summary::before{content:"›";font-size:14px;color:var(--qq-3);
  display:inline-block;transition:transform .15s ease}
.qq-panel .qq-collapse[open]>summary::before{transform:rotate(90deg)}
.qq-panel .qq-collapse>summary:hover{color:var(--qq-1);background:var(--qq-sunken)}
.qq-panel .qq-collapse .body{padding:6px 12px 12px;font-size:12.5px;line-height:1.75;color:var(--qq-2)}
.qq-panel .qq-collapse .body strong,.qq-panel .qq-collapse .body b{color:var(--qq-1)}

/* ── 状态摘要 ─────────────────────────────────────────────────────────── */
.qq-panel .hero{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.qq-panel .hero .state{font-size:14px;font-weight:500;line-height:1.4}
.qq-panel .empty{border:1px dashed var(--qq-line);border-radius:var(--qq-r-sm);padding:14px;
  text-align:center;font-size:12px;color:var(--qq-3)}

/* ── 二维码 ───────────────────────────────────────────────────────────── */
.qq-panel .qrcode{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px;
  background:#fff;border-radius:var(--qq-r-sm);border:var(--qq-hair)}
.qq-panel .qrcode img{width:208px;height:208px;display:block;image-rendering:pixelated}

/* ── 降级链 ───────────────────────────────────────────────────────────── */
.qq-panel .chain{display:flex;flex-direction:column;gap:6px}
.qq-panel .chain-item{display:flex;gap:8px;align-items:center;padding:7px 10px;
  border-radius:var(--qq-r-sm);border:var(--qq-hair);background:var(--qq-sunken);font-size:12.5px}
.qq-panel .chain-item .idx{width:20px;height:20px;border-radius:6px;flex:none;display:grid;place-items:center;
  font-size:11px;font-variant-numeric:tabular-nums;color:var(--qq-2);
  background:var(--qq-surface);border:var(--qq-hair)}
.qq-panel .chain-item .pm{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 日志 ─────────────────────────────────────────────────────────────── */
.qq-panel .logbox{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;
  color:var(--qq-2);background:var(--dsw-alias-bg-base,var(--qq-sunken));
  border:var(--qq-hair);border-radius:var(--qq-r-sm);padding:10px 12px;
  max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all}

/* ── 标签页：分段控件 ─────────────────────────────────────────────────── */
.qq-panel .tabs{display:flex;gap:2px;flex-wrap:wrap;padding:3px;border-radius:var(--qq-r);
  background:var(--qq-sunken);border:var(--qq-hair)}
.qq-panel .tab{appearance:none;border:0;background:none;font:inherit;font-size:13px;line-height:20px;
  min-height:0;color:var(--qq-2);padding:6px 14px;border-radius:calc(var(--qq-r) - 4px);
  cursor:pointer;transition:background .12s ease,color .12s ease}
.qq-panel .tab:hover{color:var(--qq-1);background:none}
.qq-panel .tab.on{background:var(--qq-surface);color:var(--qq-1);font-weight:500;
  box-shadow:0 0 0 .5px var(--qq-line),0 1px 2px rgba(0,0,0,.06)}

/* ── 其他 ─────────────────────────────────────────────────────────────── */
.qq-panel .spin{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-2px;
  border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:var(--qq-brand);
  animation:qqspin .7s linear infinite}
.qq-panel :is(button,input,select,textarea,summary,.tab,.switch):focus-visible{
  outline:2px solid var(--dsw-focus-ring-color,var(--qq-brand));outline-offset:2px}
@keyframes qqspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.qq-panel *{transition:none!important;animation-duration:.001s!important}}
`

    const styleEl = document.createElement('style')
    styleEl.textContent = CSS
    styleEl.dataset.llminqq = '1'
    document.head.appendChild(styleEl)

    // ── HTTP 小工具 ─────────────────────────────────────────────────────────
    // 一律带超时：没有超时的 fetch 遇到「后端卡住/半死」会一直挂着，
    // 界面就停在 loading（用户看到的是「设置页一直转圈」）。
    const API_TIMEOUT_MS = 30000
    async function api (path, init) {
      // 调用方自己传了 signal 就不覆盖（少数长任务用得更久）
      const signal = init?.signal ?? (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(API_TIMEOUT_MS)
        : undefined)
      let r
      try {
        r = await fetch(API + path, {
          headers: { 'content-type': 'application/json' },
          ...init,
          signal,
        })
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          return { ok: false, error: `请求超时（${Math.round(API_TIMEOUT_MS / 1000)}s）：后端可能卡住了，看「运行」页的日志` }
        }
        throw err
      }
      const text = await r.text()
      let body
      try { body = JSON.parse(text) } catch { body = { ok: false, error: text.slice(0, 300) } }
      if (!r.ok && body && !body.error && !body.reason) body.error = `HTTP ${r.status}`
      return body
    }
    const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data ?? {}) })

    // 字节数：浏览器没有 Buffer，用 TextEncoder。包一层是为了
    // 「万一环境连 TextEncoder 都没有」也不要让整页白屏。
    // （教训：client 里写了 `Buffer ? ...` —— 引用未声明标识符会 ReferenceError，
    //   而且是在 render 里抛的，React 直接把整个设置页变白。）
    function byteLenOf (s) {
      try { return new TextEncoder().encode(s).length } catch { return String(s).length }
    }

    // ── 通用小组件 ──────────────────────────────────────────────────────────
    function Switch ({ on, onChange, disabled }) {
      return h('span', {
        className: 'switch' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': !!on,
        'aria-disabled': disabled ? true : undefined,
        tabIndex: disabled ? -1 : 0,
        onClick: () => { if (!disabled) onChange(!on) },
        onKeyDown: e => {
          if (disabled) return
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!on) }
        },
        style: disabled ? { opacity: .4, cursor: 'not-allowed' } : undefined,
      })
    }

    function SwitchRow ({ label, desc, on, onChange, disabled }) {
      return h('div', { className: 'switchrow' },
        h('div', { className: 'lbl' },
          h('div', null, label),
          desc ? h('div', { className: 'dsc' }, desc) : null,
        ),
        h(Switch, { on, onChange, disabled }),
      )
    }

    function Field ({ label, sub, children }) {
      return h('div', { className: 'field' },
        label ? h('label', null, label) : null,
        children,
        sub ? h('div', { className: 'sub' }, sub) : null,
      )
    }

    // title 可选：带标题的提示条读起来更清楚，不需要时跟以前一样
    function Notice ({ kind, title, children }) {
      if (!children) return null
      return h('div', { className: 'notice' + (kind ? ' ' + kind : '') },
        title ? h('div', { className: 'notice-title' }, title) : null,
        children)
    }

    function Badge ({ kind, children }) {
      return h('span', { className: 'badge' + (kind ? ' ' + kind : '') }, children)
    }

    // 键值表：rows = [[标签, 值, 是否正常]]
    // 用来替代「一行行手写 flex + 固定宽度 span」——之前体检表和底部信息都这么堆出来的。
    function KV ({ rows }) {
      const kids = []
      rows.forEach(([k, v, ok], i) => {
        kids.push(h('dt', { key: 'k' + i }, k))
        kids.push(h('dd', { key: 'v' + i }, v))
        kids.push(h('dd', { key: 'f' + i, className: 'flag' + (ok ? ' ok' : '') }, ok ? '✓' : '—'))
      })
      return h('dl', { className: 'kv' }, kids)
    }

    // 命令块 + 复制按钮。copy 由调用方传（它要能写 setResult 反馈）
    function Code ({ text, onCopy, copyLabel }) {
      if (!text) return null
      return h('div', { className: 'codewrap' },
        h('pre', { className: 'code' }, text),
        onCopy
          ? h('button', { className: 'tiny copybtn', onClick: () => onCopy(text) }, copyLabel || '复制')
          : null,
      )
    }

    // 折叠块：用 native <details>，不用 React state，键盘/无障碍都是现成的。
    //
    // 但**内容要延迟挂载**：<details> 折叠时子节点仍然在 DOM 里，React 也会照常
    // 挂载它们。折叠块里装的是 SetupWizard / BiliSetup 这些「一挂载就自己发请求」的
    // 组件（SetupWizard 会打一次 /env/probe，实测 380ms，里面还要跑 docker images
    // 和七个端口的探测）。用户根本没展开，却每次打开设置页都付一遍这个钱。
    // 现在第一次展开前只渲染空壳。
    function Collapse ({ title, children }) {
      // ⚠️ 类名必须带 qq- 前缀：宿主的全局内联样式里有 `.collapse{visibility:collapse}`，
      //   裸用 'collapse' 会被它命中 → DOM 在、高度在、但看不见（表现是「一块空白占位」）。
      //   改名根治，CSS 里的 !important 是双保险。
      const [opened, setOpened] = React.useState(false)
      return h('details', {
        className: 'qq-collapse',
        onToggle: e => { if (e.currentTarget.open && !opened) setOpened(true) },
      },
      h('summary', null, title),
      h('div', { className: 'body' }, opened ? children : null),
      )
    }

    // 文本输入：本地先存，失焦/回车再提交（避免每个字符一次请求）
    function TextInput ({ value, onCommit, placeholder, type = 'text', disabled }) {
      const [local, setLocal] = useState(value ?? '')
      const focused = useRef(false)
      useEffect(() => { if (!focused.current) setLocal(value ?? '') }, [value])
      const commit = () => { if (local !== (value ?? '')) onCommit(local) }
      return h('input', {
        type,
        value: local,
        placeholder,
        disabled,
        onFocus: () => { focused.current = true },
        onChange: e => setLocal(e.target.value),
        onBlur: () => { focused.current = false; commit() },
        onKeyDown: e => { if (e.key === 'Enter') { e.currentTarget.blur() } },
      })
    }

    function NumberInput ({ value, onCommit, min, max, disabled }) {
      const [local, setLocal] = useState(String(value ?? ''))
      const focused = useRef(false)
      useEffect(() => { if (!focused.current) setLocal(String(value ?? '')) }, [value])
      return h('input', {
        type: 'number', min, max, value: local, disabled,
        onFocus: () => { focused.current = true },
        onChange: e => setLocal(e.target.value),
        onBlur: () => {
          focused.current = false
          const n = Number(local)
          if (Number.isFinite(n) && n !== value) onCommit(n)
          else setLocal(String(value ?? ''))
        },
      })
    }

    // 选模型：能拿到清单就用下拉（防手打错 id），拿不到才退回手填输入框。
    // 模型清单是**按 provider 拉**的（每个 provider 公布的模型不同），
    // 所以 provider 一变就要重新拉一次。
    function ModelPicker ({ provider, value, onChange, emptyLabel = '（未设置）', placeholder = '模型 id' }) {
      const [list, setList] = useState(null)
      const [loading, setLoading] = useState(false)

      useEffect(() => {
        if (!provider) { setList(null); return }
        let alive = true
        setLoading(true)
        api('/models/list?provider=' + encodeURIComponent(provider))
          .then(r => { if (alive) setList(r) })
          .catch(err => { if (alive) setList({ models: [], reason: '取模型清单失败：' + err.message }) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [provider])

      if (!provider) {
        return h('select', { value: '', disabled: true },
          h('option', { value: '' }, '先选 provider'))
      }
      if (loading && !list) {
        return h('select', { value: '', disabled: true }, h('option', { value: '' }, '加载模型清单…'))
      }
      const models = list?.models || []
      if (models.length === 0) {
        return h(React.Fragment, null,
          h(TextInput, { value, onCommit: onChange, placeholder }),
          list?.reason ? h('div', { className: 'hint' }, list.reason) : null)
      }
      return h('select', { value: value || '', onChange: e => onChange(e.target.value) },
        h('option', { value: '' }, emptyLabel),
        models.map(m => h('option', { key: m.id, value: m.id },
          (m.name === m.id ? m.id : `${m.name} (${m.id})`) +
          (m.inputModalities?.includes('image') ? ' · 看图' : ''))),
        // 配置里的模型可能这个 provider 已经不下发了，仍然要能看见它
        value && !models.some(m => m.id === value)
          ? h('option', { key: value, value }, value + '（当前配置）')
          : null)
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function QQPanel ({ ctx }) {
      const [tab, setTab] = useState('login')
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)     // {kind, text}
      const [loading, setLoading] = useState(true)

      const inflightRef = useRef(false)
      const refresh = useCallback(async () => {
        // 轮询是 4 秒一次，而 /overview 里的 docker/登录探测在慢机器上要十几秒：
        // 不挡的话新一轮在上一轮没回来时就发出去，请求层层叠加，越叠越慢、越慢越叠。
        if (inflightRef.current) return
        inflightRef.current = true
        try {
          const r = await api('/overview')
          if (r.ok) setData(r)
          else setMsg({ kind: 'err', text: r.error || r.reason || '读取状态失败' })
        } catch (err) {
          setMsg({ kind: 'err', text: '连不上插件后端：' + err.message })
        } finally {
          inflightRef.current = false
          setLoading(false)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      // 登录页轮询：等扫码的阶段要自动刷新（用户扫完想知道成没成）
      useEffect(() => {
        if (tab !== 'login' || !data) return
        const state = data.env?.login?.state
        const needPoll = state === 'waiting-scan' || state === 'starting' || state === 'not-created'
        if (!needPoll) return
        const t = setInterval(refresh, 4000)
        return () => clearInterval(t)
      }, [tab, data, refresh])

      const run = useCallback(async (label, fn) => {
        setBusy(label); setMsg(null)
        try {
          const r = await fn()
          if (r && r.ok === false) setMsg({ kind: 'err', text: r.error || r.reason || '操作失败' + (r.detail ? '：' + r.detail : '') })
          else if (r && r.issues) setMsg({ kind: 'err', text: '配置有问题：' + r.issues.join('；') })
          await refresh()
          return r
        } catch (err) {
          setMsg({ kind: 'err', text: err.message })
        } finally { setBusy('') }
      }, [refresh])

      // 保存配置的一个片段
      const saveConfig = useCallback(async (patch) => {
        const r = await post('/config', patch)
        if (r.ok) {
          setData(d => d ? { ...d, config: r.config } : d)
          if (r.restarted) {
            setMsg({ kind: 'ok', text: '已保存，桥正在自动重启（几秒后生效）' })
          } else if (r.needsRestart) {
            setMsg({ kind: 'warn', text: '已保存。桥正在运行，需要重启桥才生效（去「运行」页点重启）' })
          } else {
            setMsg({ kind: 'ok', text: '已保存' })
          }
        } else {
          setMsg({ kind: 'err', text: r.error || r.issues?.join('；') || '保存失败' })
        }
        return r
      }, [])

      if (loading) {
        return h('div', { className: 'qq-panel' },
          h('div', { className: 'hint' }, h('span', { className: 'spin' }), ' 正在读取插件状态…'))
      }
      if (!data) {
        return h('div', { className: 'qq-panel' },
          h(Notice, { kind: 'err' }, msg?.text || '读不到插件状态'))
      }

      const cfg = data.config || {}
      const env = data.env || {}

      const tabs = [
        ['login', '登录'],
        ['model', '模型'],
        ['behavior', '行为'],
        ['memory', '记忆'],
        ['persona', '人格'],
        ['run', '运行'],
        ['advanced', '高级'],
      ]

      return h('div', { className: 'qq-panel' },
        h('div', { className: 'tabs' },
          tabs.map(([id, label]) => h('button', {
            key: id,
            className: 'tab' + (tab === id ? ' on' : ''),
            onClick: () => { setTab(id); setMsg(null) },
          }, label)),
        ),
        msg ? h(Notice, { kind: msg.kind }, msg.text) : null,
        data.config?._loadError
          ? h(Notice, { kind: 'err', title: '配置文件读不出来' }, data.config._loadError)
          : null,
        h(CapabilityNotice, { caps: env.capabilities }),

        tab === 'login' && h(LoginTab, { data, cfg, env, busy, run, refresh, saveConfig }),
        tab === 'model' && h(ModelTab, { data, cfg, env, busy, run, saveConfig, setMsg }),
        tab === 'behavior' && h(BehaviorTab, { cfg, saveConfig, env, data }),
        tab === 'memory' && h(MemoryTab, { run, setMsg }),
        tab === 'persona' && h(PersonaTab, { run, setMsg }),
        tab === 'run' && h(RunTab, { data, busy, run, refresh }),
        tab === 'advanced' && h(AdvancedTab, { data, cfg, saveConfig, run, setMsg }),

        // 页脚放最后：版本/加载路径是排查用的，不该占据首屏
        h(VersionFooter),
      )
    }

    // 版本页脚：显示「后端实际加载的那份代码在哪、什么版本」。
    //
    // 为什么要放在界面上（真实踩坑）：
    //   pnpm 的 node_modules\<包名> 常常是指向 .pnpm 的指针，用户改了顶层那份
    //   但 dsh 加载的是 .pnpm 里的真实副本 —— 改了没生效，还查不出来。
    //   把后端 __dirname 显示出来，「我改的」和「它加载的」是不是同一处一眼就清楚。
    //   顺便显示三个新版才有标记，缺哪个就是代码没换到。
    function VersionFooter () {
      const [info, setInfo] = useState(null)
      useEffect(() => {
        api('/version').then(r => { if (r && r.ok) setInfo(r) }).catch(() => {})
      }, [])
      if (!info) return null
      const stale = []
      if (!info.hasEnvModule) stale.push('lib/env.js')
      if (!info.hasSetupWizard) stale.push('设置页新组件')
      // 压成两行小字：排查用，不该在主界面上抢注意力
      return h('div', { className: 'muted' },
        h('div', { className: 'row', style: { gap: 10 } },
          h('span', null, `v${info.version} · Node ${info.nodeVersion} · ${info.platform}`),
          stale.length > 0
            ? h('span', { style: { color: 'var(--qq-bad)' } },
                `⚠ 旧版代码（缺：${stale.join('、')}）—— 你改的不是它加载的那份`)
            : h('span', { style: { color: 'var(--qq-ok)' } }, '✓ 模块齐全'),
        ),
        h('div', { className: 'mono', style: { marginTop: 3, wordBreak: 'break-all', opacity: .85 } },
          info.pluginRoot),
      )
    }

    // 能力提示：宿主缺了关键服务时明确说出来，而不是让功能静默失效。
    // （桌面版可能没有 webServer 或 settings slot —— 用户会看到「页面在但点什么都没反应」，
    //   那种体验最差，所以这里直接告诉他缺什么。）
    function CapabilityNotice ({ caps }) {
      if (!caps) return null
      // Docker 不算「缺能力」：本机版 NapCat 一样能跑，把它列成警告只会让人
      // 以为「没装 Docker 就用不了」—— 之前那条橙色提示就是这么误导人的。
      const missing = []
      if (!caps.llm) missing.push('LLM 服务（→ 模型页的 provider 列表会是空的）')
      if (!caps.agentDefaultModel) missing.push('默认模型服务（→ 不能同步宿主模型，只能用插件自己的配置）')
      if (missing.length === 0) return null
      return h(Notice, { kind: 'warn', title: '宿主缺少部分能力' },
        h('ul', { style: { marginTop: 6 } }, missing.map((m, i) => h('li', { key: i }, m))),
        h('div', { className: 'muted', style: { marginTop: 6 } },
          `平台 ${caps.platform || '?'} · Node ${caps.nodeVersion || '?'} —— 桥本身不依赖这些。`),
      )
    }

    // ── 环境体检 + 一键安装 ──────────────────────────────────────────────────
    //
    // 设计要点（为什么不是一个「安装全部」的按钮）：
    //   Windows 上 Docker Desktop 要 GUI 向导 + 管理员 + 重启，插件替你做不了。
    //   硬做一个自动按钮只会「转圈然后失败」，比明说更糟。
    //   所以：能自动的（拉镜像/起容器/连已有 NapCat）就一键做；
    //   不能自动的（装 Docker Desktop）给准确指引 + 可复制命令。
    // 安装指引正文：docker 与本地 NapCat 两条路共用同一套渲染
    // （之前是两份几乎逐字重复的 JSX，改一处文案要改两遍）
    function Guide ({ g, onCopy }) {
      if (!g) return null
      return h(React.Fragment, null,
        g.why ? h('div', { style: { marginBottom: 8 } }, g.why) : null,
        g.steps?.length ? h('ol', null, g.steps.map((s, i) => h('li', { key: i }, s))) : null,
        g.command ? h('div', { style: { margin: '8px 0' } }, h(Code, { text: g.command, onCopy })) : null,
        g.postSteps?.length ? h('ol', { style: { marginTop: 8 } }, g.postSteps.map((s, i) => h('li', { key: i }, s))) : null,
        g.hints?.length ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'muted', style: { marginBottom: 3 } }, '常见问题'),
          g.hints.map((s, i) => h('div', { key: i, className: 'mono', style: { fontSize: 11.5 } }, s))) : null,
        g.altCommand ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'muted', style: { marginBottom: 3 } }, g.altCommand.label),
          h('ol', null, g.altCommand.steps.map((s, i) => h('li', { key: i }, s)))) : null,
      )
    }

    // B站 MCP 的一键装依赖。两处用到（登录页的安装指引、行为页的工具卡），
    // 所以单独拆出来：里面要跑 pip（慢），得有自己的进度与日志，不能每次渲染都重跑。
    function BiliSetup ({ bili, venv }) {
      const [busy, setBusy] = useState(false)
      const [lines, setLines] = useState([])
      const [done, setDone] = useState(null)

      const go = async () => {
        setBusy(true); setLines([]); setDone(null)
        try {
          const r = await post('/mcp/bili/setup', {})
          setLines(Array.isArray(r.log) ? r.log : [])
          setDone(r.ok
            ? { kind: 'ok', text: '装好了。把「B站工具」和「B站工具（MCP）」都打开，再重启桥一次。' }
            : { kind: 'err', text: r.detail || r.error || '装失败（看下面的日志）' })
        } catch (e) {
          setDone({ kind: 'err', text: '装失败：' + e.message })
        } finally { setBusy(false) }
      }

      const venvPath = bili?.venv || venv || ''
      const state = bili?.ok
        ? { kind: 'ok', text: '当前可用：' + (bili?.pythonBin || venvPath) }
        : null
      return h('div', { style: { marginTop: 6 } },
        state ? h(Notice, { kind: state.kind }, state.text) : null,
        h('div', { className: 'muted', style: { fontSize: 12, lineHeight: 1.7 } },
          'MCP 服务器是插件自带的，不用另外装 bili-duty；需要的只是一个装了 Python 依赖的 venv。',
          venvPath ? h('div', { className: 'mono' }, 'venv 位置：' + venvPath) : null,
        ),
        h('div', { className: 'row', style: { marginTop: 8 } },
          h('button', { className: 'primary', disabled: busy, onClick: go },
            busy ? '正在装依赖…（首次要下载，可能一两分钟）' : (bili?.ok ? '重装依赖（换 venv 也行）' : '一键装依赖')),
          h(Collapse, { title: '想自己手动装' },
            h('div', { className: 'muted', style: { fontSize: 12, lineHeight: 1.8 } },
              h('div', null, '1. 建 venv：python -m venv "' + (venvPath || '<venv 目录>') + '"'),
              h('div', { className: 'mono' }, '2. 装依赖："' + (venvPath || '<venv>') + '\\Scripts\\python.exe" -m pip install -r "' + (bili?.requirements || 'vendor/bilibili-mcp/requirements.txt') + '"'),
              h('div', null, '3. 回「行为」页打开两个 B站 开关，重启桥'),
            )),
        ),
        done ? h(Notice, { kind: done.kind }, done.text) : null,
        lines.length
          ? h(Collapse, { title: `安装日志（${lines.length} 行）` },
              h('div', { className: 'logbox', style: { maxHeight: 220 } }, lines.join('\n')))
          : null,
      )
    }

    function SetupWizard ({ env, cfg, saveConfig, onDone }) {
      const [probe, setProbe] = useState(null)
      const [loading, setLoading] = useState(true)
      const [step, setStep] = useState('')
      const [result, setResult] = useState(null)

      // force=true 时跳过服务端缓存。
      //
      // 首次挂载走缓存（30s 内复用上次结果）—— 用户只是打开设置页看二维码，
      // 不该先等 270ms 的六项探测；而「测试连接 / 重新探测」必须传 force，
      // 不然就是「点了不生效」，正是这次二维码刷新踩过的那个坑。
      const refreshProbe = useCallback(async ({ force = false } = {}) => {
        setLoading(true)
        try {
          const r = await api('/env/probe' + (force ? '?force=1' : ''))
          if (r.ok) setProbe(r)
          else setResult({ kind: 'err', text: r.error || '探测失败' })
        } catch (e) {
          setResult({ kind: 'err', text: '探测失败：' + e.message })
        } finally { setLoading(false) }
      }, [])

      useEffect(() => { refreshProbe() }, [refreshProbe])

      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          setResult({ kind: 'ok', text: '已复制到剪贴板' })
        } catch {
          setResult({ kind: 'warn', text: '复制失败，请手动选中复制' })
        }
      }

      // 一键：拉镜像 → 起容器 → 等 OneBot 就绪
      //
      // ⚠️ 整个流程必须 try/finally：按钮是 `disabled: !!step`，
      // 而 step 只在成功路径上被 setStep('') 复位。任何一次 await 抛异常
      // （网络断、宿主 500、请求超时）都会让 step 永远停在文案上 →
      // 按钮永久禁用+一直转圈，用户以为「正在装」其实什么都没在发生。
      const oneClickDocker = async () => {
        setResult(null)
        try {
          setStep('正在拉取镜像（首次约 2GB，慢的话几分钟）…')
          const pull = await post('/env/pull-image')
          if (!pull.ok) {
            setResult({ kind: 'err', text: '拉镜像失败：' + (pull.detail || pull.error || '').slice(-400) })
            return
          }
          setStep('镜像就绪，正在启动容器…')
          const started = await post('/napcat/start')
          if (!started.ok) {
            setResult({
              kind: 'err',
              text: '容器启动失败：' + (started.reason || started.error || '') +
                (started.detail ? '\n\n' + started.detail : ''),
            })
            return
          }
          setStep('容器已起，正在等 NapCat 就绪（它内部要启动完整的 QQ 客户端，约 10~60 秒）…')
          const waited = await post('/env/wait-onebot', { timeoutMs: 120000 })
          if (waited.ok) {
            setResult({ kind: 'ok', text: '✓ 就绪！下面应该出现二维码了，用手机 QQ 扫。' })
          } else {
            setResult({
              kind: 'warn',
              text: `容器起了，但 ${waited.port || 3001} 端口 ${Math.round((waited.timeoutMs || 90000) / 1000)} 秒内没就绪。\n` +
                '可能还在启动（再等一会儿点刷新），或者去「运行」页看容器日志。',
            })
          }
          // 刚起完容器，状态确实变了 —— 必须 force，不能读到 30 秒内的旧快照
          await refreshProbe({ force: true })
          onDone?.()
        } catch (e) {
          setResult({ kind: 'err', text: '一键安装中断：' + (e?.message || e) + '\n可以直接重试；也可以切到「手动」按步骤来。' })
        } finally {
          // 无论成功、失败还是抛异常，都把 step 复位，别让按钮卡死
          setStep('')
        }
      }

      // 一键：连已经在跑的本机 NapCat
      const useExisting = async () => {
        setResult(null)
        try {
          setStep('正在测试连接…')
          const waited = await post('/env/wait-onebot', { timeoutMs: 8000 })
          if (waited.ok) {
            setResult({ kind: 'ok', text: `✓ ${waited.port} 端口通，可以点「启动桥」了` })
          } else {
            setResult({ kind: 'err', text: '端口不通。确认 NapCat 已经启动，且 OneBot 正向 WS 端口是 ' + (probe?.onebotPort || 3001) })
          }
        } catch (e) {
          setResult({ kind: 'err', text: '测试连接失败：' + (e?.message || e) })
        } finally {
          setStep('')
        }
        // 用户点「测试连接」就是要看当前真相，跳过缓存
        await refreshProbe({ force: true })
      }

      if (loading) {
        return h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '环境体检'),
          h('div', { className: 'hint' }, h('span', { className: 'spin' }), ' 正在探测这台机器…'))
      }
      if (!probe) return null

      const rec = probe.recommended
      const dg = probe.guides?.docker || {}
      const lg = probe.guides?.localNapcat || {}

      // 能力行
      const rows = [
        ['操作系统', `${probe.platformLabel} ${probe.arch}`, true],
        ['Docker', probe.docker?.present
          ? (probe.docker?.usable ? probe.docker?.version : '装了但没跑起来')
          : '没装',
          probe.docker?.usable],
        ['镜像', probe.localImages?.hasTarget ? '已在本地' : '还没拉',
          probe.localImages?.hasTarget],
        ['OneBot 服务',
          probe.onebot?.found
            ? `已识别（:${probe.onebot.best.port}${probe.onebot.best.selfId ? ' · ' + probe.onebot.best.selfId : ''}）`
            : probe.localPort?.open
              ? `端口 ${probe.onebotPort} 有服务，但 OneBot 握手没成功`
              : '没找到',
          probe.onebot?.found === true],
        // 「安装目录」和「已经在跑」是两件事：以前只看 artifacts（扫安装目录），
        // 于是「NapCat 跑在别处、3001 握手都成功了」却显示「没找到」——
        // 这不是显示的小毛病，它会让人以为整条链路没连上。
        ['本机 NapCat',
          probe.artifacts?.length
            ? probe.artifacts.join(', ')
            : probe.onebot?.found
              ? `在跑（:${probe.onebot.best?.port ?? probe.onebotPort} 握手成功）`
              : '没找到',
          probe.artifacts?.length > 0 || probe.onebot?.found === true],
      ]

      return h('div', { className: 'card' },
        h('div', { className: 'card-title' }, '环境体检'),

        h(KV, { rows }),

        // B站工具依赖自检：缺 python / 没装依赖 / 开关没开是三种不同的事，
        // 分开说清楚，否则用户会按错的那条去修（这正是「装了还是读不到」的来源）。
        // 注意：MCP 服务器是插件自带的（vendor/bilibili-mcp/），不需要另外 clone bili-duty；
        // 缺的只是一个装了依赖的 venv —— 所以这里给「一键装依赖」，别再让人去 bili-duty 里 pip。
        (() => {
          const bili = env?.capabilities?.mcp?.bili
          if (bili?.ok) return null
          const venv = bili?.venv || ''
          return h(Notice, { kind: 'warn', title: 'B站工具没挂上（读不到视频内容）' },
            h('div', null, bili?.reason || '未知原因'),
            h(BiliSetup, { bili, venv: cfg.mcp?.bili?.venv || '' }),
          )
        })(),

        h(Notice, { kind: 'ok', title: `推荐：${rec.label}` }, rec.why),

        result ? h(Notice, { kind: result.kind }, h('span', { style: { whiteSpace: 'pre-wrap' } }, result.text)) : null,
        step ? h('div', { className: 'hint' },
          h('span', { className: 'spin' }), ' ' + step) : null,

        // 只给「能自动做」的按钮；不能自动的在下面折叠里给命令
        h('div', { className: 'row' },
          rec.id === 'docker' && h('button', {
            className: 'primary',
            disabled: !!step,
            onClick: oneClickDocker,
          }, '一键装好并启动'),

          // 测试按钮一直给：探测失败的时候最需要它（有可能只是 token/端口不对）
          h('button', {
            className: rec.id === 'existing' ? 'primary' : '',
            disabled: !!step,
            onClick: useExisting,
          }, probe.onebot?.found ? '再测一次连接' : '测试 OneBot 连接'),
        ),

        // 手动路线：折叠起来，不点开就不占地方
        h('div', { style: { marginTop: 2 } },
          h(Collapse, { title: dg.title || '装 Docker' },
            h(Guide, { g: dg, onCopy: copy })),
          h(Collapse, {
            title: (lg.title || '不装 Docker，直接跑 NapCat') + (lg.recommended ? '（推荐）' : ''),
          }, h(Guide, { g: lg, onCopy: copy })),
        ),

        h('div', { className: 'muted' }, `数据目录 ${probe.dataDir}`),
      )
    }

    // ── 登录页 ──────────────────────────────────────────────────────────────
    function LoginTab ({ data, cfg, env, busy, run, refresh, saveConfig }) {
      const login = env.login || {}
      const container = env.container || {}
      const docker = env.docker || {}
      const onebot = env.onebot || { found: false, hits: [], best: null }
      const bridge = (data && data.bridge) || {}
      const [qrNonce, setQrNonce] = useState(Date.now())
      const [qrBroken, setQrBroken] = useState(false)
      const [qrBusy, setQrBusy] = useState(false)
      const [qrMsg, setQrMsg] = useState(null)

      // 二维码新鲜度文案。
      //
      // 为什么值得显示：QQ 的登录二维码大约 2 分钟就过期。过期后扫不出反应，
      // 用户第一反应是「插件坏了」，而不是「码过期了」。把「这张是 X 分钟前拿到的
      // / 可能过期了，点右边换一张」直接写在按钮旁边，比任何文档都管用。
      function qrAgeText (ageMs, state) {
        if (state === 'waiting-scan' && (ageMs === null || ageMs === undefined)) return ''
        if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return ''
        const s = Math.round(ageMs / 1000)
        if (s < 60) return '刚拿到的'
        if (s < 120) return `${Math.round(s / 60)} 分钟前，还能扫`
        return `${Math.floor(s / 60)} 分钟前，可能已过期 —— 点一下换新码`
      }

      // 「重新获取二维码」= 真的让 NapCat 换一张新码。
      //
      // 以前这个按钮只是 `setQrNonce(Date.now())` 换个 URL 参数重新请求 /qr.png，
      // 而后端那边也只是重新 docker cp 一次**同一个文件** —— 两头都没让 NapCat 换码，
      // 所以接口回 true、图片却和上一张一模一样。用户的原话就是「点了刷新没反应」。
      //
      // 现在：先 POST /qr/refresh 让后端调 NapCat 的 RefreshQRcode，等它落盘后再
      // 换 nonce 重新取图；失败就如实说失败（而不是默默显示旧码）。
      const refreshQr = async () => {
        setQrBusy(true); setQrMsg(null); setQrBroken(false)
        try {
          const r = await post('/qr/refresh')
          if (r && r.ok) {
            setQrNonce(Date.now())
            setQrMsg({ kind: 'ok', text: '已换新码，用手机 QQ 扫这张' })
          } else {
            setQrMsg({
              kind: 'warn',
              text: (r && (r.reason || r.error) || '刷新失败') +
                (r && r.detail ? '：' + r.detail : ''),
            })
            // 刷新失败但后端还有旧码可显示 —— 仍然刷新一次，至少不是空白
            if (r && r.hasImage) setQrNonce(Date.now())
          }
        } catch (err) {
          setQrMsg({ kind: 'err', text: '刷新失败：' + err.message })
        } finally {
          setQrBusy(false)
        }
      }

      // 状态判定要同时看「Docker 容器」和「本机 NapCat」两条路。
      // 之前只有 Docker 一条，所以本机跑的 NapCat 一律显示「✗ Docker 不可用」——
      // 用户明明已经把 NapCat 登录上了，界面还在报错，这是误导。
      const stateBadge = (() => {
        if (onebot.found) {
          const b = onebot.best
          return h(Badge, { kind: 'ok' },
            `OneBot 在线${b.selfId ? ' · ' + b.selfId : ''}`)
        }
        if (!docker.ok) return h(Badge, { kind: 'warn' }, '未连接 OneBot')
        if (login.loggedIn) return h(Badge, { kind: 'ok' }, '已登录')
        if (login.state === 'waiting-scan') return h(Badge, { kind: 'warn' }, '等待扫码')
        if (login.state === 'starting') return h(Badge, { kind: 'warn' }, '启动中')
        if (login.state === 'kicked') return h(Badge, { kind: 'bad' }, '被踢下线')
        if (login.state === 'not-created') return h(Badge, null, '未启动')
        return h(Badge, null, login.state || '未知')
      })()

      // 一句话回答「现在能不能用」——比一串状态码有用
      const headline = onebot.found
        ? '能收发消息了'
        : login.loggedIn
          ? 'QQ 已登录，等着桥去连'
          : '还没连上 QQ'

      // 走本机 NapCat 时它有自己的登录界面，插件不必再显示二维码
      const showQr = docker.ok && !onebot.found && !login.loggedIn &&
        (login.state === 'waiting-scan' || login.state === 'starting')

      return h(React.Fragment, null,
        // 状态卡：进来第一眼要知道「现在能不能用」
        h('div', { className: 'card' },
          h('div', { className: 'hero' },
            h('span', { className: 'state' }, headline),
            stateBadge,
            h('button', { className: 'tiny', style: { marginLeft: 'auto' }, onClick: refresh }, '重新探测'),
          ),

          // 一行说清「还差什么」。badge 已经把状态说了，这里只补下一步动作
          h('div', { className: 'muted' },
            onebot.found
              ? (bridge.running
                  ? `已连上 OneBot（:${onebot.best.port}${onebot.best.selfId ? ' · ' + onebot.best.selfId : ''}），去 QQ 里发条消息试试`
                  : `OneBot 在 :${onebot.best.port} 就绪，还差一步：启动桥`)
              : login.loggedIn
                ? 'QQ 已经登录，桥连上 OneBot 就能收发消息'
                : '照着下面的检查把环境弄好，再扫码登录'),

          // 只差启动桥时，别让人自己跑去「运行」页
          onebot.found && !bridge.running
            ? h('div', { className: 'row' },
                h('button', {
                  className: 'primary',
                  disabled: !!busy,
                  onClick: () => run('start-bridge', () => post('/bridge/start')),
                }, '启动桥'))
            : null,

          onebot.found && onebot.hits?.length > 1
            ? h('div', { className: 'muted' },
                `同时在 ${onebot.hits.map(x => ':' + x.port).join(' ')} 也探测到了`)
            : null,

          // 没连上：说清现在该做什么，而不是报 Docker 错误
          !onebot.found && h('div', null,
            h(Notice, { title: '还没探测到 OneBot' },
              `NapCat 要开一个「WebSocket 服务器」（端口 ${cfg.napcat?.onebotPort || 3001}），桥才连得上：`),
            h('ol', { style: { marginTop: 6 } },
              h('li', null, '打开 NapCat WebUI（本机启动时控制台会打印地址）'),
              h('li', null, '「网络配置」→ 新建 → 选「WebSocket 服务器」，Host 填 127.0.0.1'),
              h('li', null, '保存并启用，回来点「重新探测」'),
            ),
          ),

          // Docker 相关错误只在真的用 Docker 时才报
          !onebot.found && !docker.ok && docker.reason && container.state !== 'not-created'
            ? h('div', { className: 'muted' }, docker.reason)
            : null,

          login.state === 'kicked'
            ? h(Notice, { kind: 'err' }, '被踢下线了。凭证已被服务端作废，只能重新扫码。')
            : null,

          // 「消息进来了但不回」最常见的原因就是这个：白名单比的是**对方的号**，
          // 填成机器人自己的号等于谁都不放行（日志里表现为 `忽略消息 … (allow 判定)`）。
          (() => {
            const selfId = String(onebot.best?.selfId || '')
            const allow = (cfg.policy?.allowUsers || []).map(String)
            if (!selfId || !allow.includes(selfId)) return null
            return h(Notice, { kind: 'warn', title: '白名单里填的是机器人自己的号' },
              `allowUsers 里是 ${selfId}，而白名单比的是「对方」的号 —— 别人的私聊会被 allow 判定全部忽略（桥日志里是「忽略消息 … (allow 判定)」）。把想让它回的人的号填进去。`)
          })(),

          // 容器操作：状态用文字，动作用按钮
          docker.ok ? h('div', { className: 'row', style: { marginTop: 2 } },
            container.state === 'running'
              ? h('button', {
                  disabled: !!busy,
                  onClick: () => run('stop-napcat', () => post('/napcat/stop')),
                }, '停止容器')
              : h('button', {
                  className: onebot.found ? '' : 'primary',
                  disabled: !!busy,
                  onClick: () => run('start-napcat', () => post('/napcat/start')),
                }, '启动 QQ 容器'),
            container.state === 'running'
              ? h('span', { className: 'muted' }, '容器运行中')
              : null,
          ) : null,
          container.state === 'not-created' && docker.ok
            ? h('div', { className: 'hint' }, '第一次启动要拉镜像（2GB+），可能要几分钟。起完这里会出现二维码。')
            : null,
        ),

        // 二维码（只有走 Docker 才需要，本机 NapCat 用它自己的界面扫）
        showQr && h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '用手机 QQ 扫码登录'),
          h('div', { className: 'qrcode' },
            qrBroken
              ? h('div', { className: 'muted' }, '还没拿到二维码（容器可能还在启动，等 10~30 秒）')
              : h('img', {
                  src: `${API}/qr.png?t=${qrNonce}`,
                  alt: 'QQ 登录二维码',
                  onError: () => setQrBroken(true),
                  onLoad: () => setQrBroken(false),
                }),
          ),
          h('div', { className: 'row' },
            h('button', {
              disabled: qrBusy,
              onClick: refreshQr,
            }, qrBusy ? '正在换新码…' : '重新获取二维码'),
            h('span', { className: 'muted' },
              qrAgeText(env?.qr?.ageMs, login.state)),
            h('a', {
              href: env.webuiUrl, target: '_blank', rel: 'noreferrer',
              style: { color: 'var(--qq-brand)', fontSize: 12 },
            }, '打开 NapCat WebUI →'),
          ),
          qrMsg
            ? h(Notice, { kind: qrMsg.kind }, qrMsg.text)
            : null,
          h(Notice, { kind: 'warn', title: '必须用小号' },
            '协议端在模拟官方客户端，违反 QQ 用户协议，有封号风险。'),
        ),

        // 安装指引只在真没连上时出现；已经能用的人不需要先读一屏安装说明
        !onebot.found && h(React.Fragment, null,
          h('div', { className: 'sec-head' }, '还没连上？'),
          h(SetupWizard, { env, cfg, saveConfig, onDone: refresh }),
        ),

        // 连上了也留个入口：换端口 / 换跑法 / B站工具没挂上时，都从这里看体检表
        onebot.found
          ? h(Collapse, { title: env?.capabilities?.mcp?.bili?.ok === false
              ? '环境体检 / B站工具没挂上 → 点开看'
              : '想改端口或换一种跑法？看环境体检' },
              h('div', { style: { marginTop: 8 } },
                h(SetupWizard, { env, cfg, saveConfig, onDone: refresh })))
          : null,

        // NapCat 配置：镜像/容器名只对 Docker 方式有意义
        docker.ok ? h('div', { className: 'card' },
          h('div', { className: 'card-title' }, 'NapCat 容器设置（仅 Docker 方式）'),
          h('div', { className: 'grid2' },
            h(Field, { label: 'WebUI 端口', sub: '浏览器扫码入口的端口' },
              h(NumberInput, {
                value: cfg.napcat?.webuiPort,
                onCommit: v => saveConfig({ napcat: { webuiPort: v } }),
              })),
            h(Field, { label: 'OneBot WS 端口', sub: '桥连这个端口，只绑 127.0.0.1' },
              h(NumberInput, {
                value: cfg.napcat?.onebotPort,
                onCommit: v => saveConfig({ napcat: { onebotPort: v } }),
              })),
          ),
          h(Field, { label: '镜像', sub: '升级 NapCat 时改这里' },
            h(TextInput, {
              value: cfg.napcat?.image,
              onCommit: v => saveConfig({ napcat: { image: v } }),
            })),
          h(Field, { label: '容器名' },
            h(TextInput, {
              value: cfg.napcat?.containerName,
              onCommit: v => saveConfig({ napcat: { containerName: v } }),
            })),
        ) : h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '连接设置'),
          h('div', { className: 'grid2' },
            h(Field, { label: 'OneBot WS 端口', sub: '你 NapCat 里「WebSocket 服务器」配置的端口' },
              h(NumberInput, {
                value: cfg.napcat?.onebotPort,
                onCommit: v => saveConfig({ napcat: { onebotPort: v } }),
              })),
            h(Field, {
              label: 'OneBot Token',
              sub: 'NapCat 网络配置里的 Token；后端不回显真值，留空 = 不修改',
            },
              h(TextInput, {
                // 后端把 token 打码成 ••••（见 lib/index.js maskConfigForUi）：
                // 直接把点显示在输入框里既难看又容易被当成真值，这里只显示空 + 提示。
                value: /^[•●*]+$/.test(String(cfg.onebot?.token || '')) ? '' : (cfg.onebot?.token || ''),
                onCommit: v => saveConfig({ onebot: { token: v } }),
                placeholder: cfg.onebot?.token ? '已配置（不回显）；留空 = 不修改' : '留空 = 不鉴权',
              })),
          ),
          h('div', { className: 'hint' },
            '填对端口和 Token 后点「重新探测」，探测到就能启动桥。'),

          // 连接反复失败时的针对性提示（折叠：连上了就不该占版面）
          h('div', { style: { marginTop: 2 } },
            h(Collapse, { title: '连不上？先看「连接断开 code=1005」这条' },
              h('div', { style: { marginTop: 8 } },
                h('div', null, '那 99% 是 Token 不对。检查两处：'),
                h('ol', { style: { marginTop: 6 } },
                  h('li', null, 'NapCat WebUI → 网络配置 → 你那个「WebSocket 服务器」→ Token 字段'),
                  h('li', null, '把那个值原样填到上面「OneBot Token」里，然后重启桥'),
                ),
                h('div', { className: 'muted', style: { marginTop: 6 } },
                  'NapCat 的 WS 服务器鉴权失败时不返回原因、直接断开 —— 日志里只有 1005，看不到 unauthorized。'),
              ))),
        ),

        // 凭据
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '凭据'),
          h('div', { className: 'hint', style: { marginBottom: 10 } },
            '存在 secrets.json（0600），不进配置 JSON，也不受「恢复默认」影响。'),
          h(Field, {
            label: '小号 QQ 号',
            sub: '掉线后免扫码快速登录；留空就每次重扫',
          }, h(SecretInput, { field: 'account', filled: data.secrets?.qqAccount, placeholder: '例如 123456789' })),
          h(Field, {
            label: 'NapCat WebUI token',
            sub: 'NapCat WebUI 的访问密码，留空自动生成',
          }, h(SecretInput, { field: 'webuiToken', filled: data.secrets?.webuiToken, placeholder: '留空自动生成' })),
          h(Field, {
            label: '本地运维 API token',
            sub: '桥的运维接口 Bearer token，留空自动生成',
          }, h(SecretInput, { field: 'serverToken', filled: data.secrets?.serverToken, placeholder: '留空自动生成' })),
        ),
      )
    }

    // 凭据输入：只写不读。已填的显示为占位符，不把真实值送到前端
    function SecretInput ({ field, filled, placeholder }) {
      const [v, setV] = useState('')
      const [saved, setSaved] = useState(false)
      const commit = async () => {
        if (!v.trim()) return
        const r = await post('/secrets', { [field]: v.trim() })
        if (r.ok) { setV(''); setSaved(true); setTimeout(() => setSaved(false), 2000) }
      }
      return h('div', { className: 'row' },
        h('div', { style: { flex: 1 } },
          h('input', {
            type: 'password',
            value: v,
            placeholder: filled ? '已设置（输入新值可覆盖）' : (placeholder || ''),
            onChange: e => setV(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') commit() },
          })),
        h('button', { className: 'tiny', disabled: !v.trim(), onClick: commit },
          saved ? '已保存' : '保存'),
      )
    }

    // ── 模型页 ──────────────────────────────────────────────────────────────
    function ModelTab ({ data, cfg, env, busy, run, saveConfig, setMsg }) {
      const models = data.models || {}
      const providers = models.providers || []
      const hostSel = models.hostSelection

      const [prov, setProv] = useState(cfg.dsh?.provider || hostSel?.provider || '')
      const [model, setModel] = useState(cfg.dsh?.model || hostSel?.model || '')
      const [effort, setEffort] = useState(cfg.dsh?.reasoningEffort || 'high')
      const [syncHost, setSyncHost] = useState(true)

      const applyMain = () => run('apply-model', () =>
        post('/models/apply', { provider: prov, model, reasoningEffort: effort, syncToHost: syncHost }))

      const routes = cfg.dsh?.fallbackRoutes || []

      // 降级链的编辑模型：**本地草稿 → 填完整了才保存**。
      //
      // 为什么不能「点添加就保存一个空的」：
      //   后端会校验「provider 和 model 都不能空」（这是对的 —— 半填状态在运行时
      //   静默不生效，比报错难查得多）。但那意味着点「添加」立刻 400 报错，
      //   用户还没开始填就被拦下来。实测就是你看到的「点击添加直接提示配置有问题」。
      //
      // 所以：draft 只在本地存在，只有 provider 和 model 都填了才进 cfg 并落盘。
      // 空行会在 UI 上标「待填写」，删掉它就消失，不会污染配置。
      const [drafts, setDrafts] = useState([])   // [{provider, model, reasoningEffort}]

      const addRoute = () => setDrafts(d => [...d, { provider: '', model: '', reasoningEffort: 'high' }])
      const updateDraft = (i, patch) => setDrafts(d => d.map((r, j) => j === i ? { ...r, ...patch } : r))
      const removeDraft = i => setDrafts(d => d.filter((_, j) => j !== i))
      const commitDraft = async (i) => {
        const d = drafts[i]
        if (!d || !d.provider || !d.model) return
        const next = [...routes, { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort || 'high' }]
        const r = await saveConfig({ dsh: { fallbackRoutes: next } })
        if (r && r.ok) setDrafts(ds => ds.filter((_, j) => j !== i))
      }
      const updateRoute = (i, patch) => {
        const next = routes.map((r, j) => j === i ? { ...r, ...patch } : r)
        // 逐条编辑时如果被改成空，说明用户正在清空 —— 先别保存，等填好
        if (next.some(r => !r.provider || !r.model)) return
        saveConfig({ dsh: { fallbackRoutes: next } })
      }

      // 换 provider 时模型要跟着换：模型清单是**按 provider 拉**的，
      // 旧的模型 id 大概率不在新 provider 的清单里（发下去只会 unknown model option）。
      const pickModelFor = async (providerId, current) => {
        if (!providerId) return ''
        try {
          const r = await api('/models/list?provider=' + encodeURIComponent(providerId))
          const ids = (r?.models || []).map(m => m.id)
          if (ids.includes(current)) return current
          return ids[0] || ''
        } catch {
          return current
        }
      }
      const changeRouteProvider = async (i, providerId) => {
        const nextModel = await pickModelFor(providerId, routes[i]?.model || '')
        if (!providerId || !nextModel) return   // 半填状态不落盘
        const next = routes.map((r, j) => j === i ? { ...r, provider: providerId, model: nextModel } : r)
        saveConfig({ dsh: { fallbackRoutes: next } })
      }
      const changeDraftProvider = async (i, providerId) => {
        updateDraft(i, { provider: providerId, model: '' })
        const nextModel = await pickModelFor(providerId, '')
        if (nextModel) updateDraft(i, { provider: providerId, model: nextModel })
      }
      const removeRoute = i => saveConfig({ dsh: { fallbackRoutes: routes.filter((_, j) => j !== i) } })
      const moveRoute = (i, dir) => {
        const j = i + dir
        if (j < 0 || j >= routes.length) return
        const next = [...routes]
        const tmp = next[i]; next[i] = next[j]; next[j] = tmp
        saveConfig({ dsh: { fallbackRoutes: next } })
      }

      return h(React.Fragment, null,
        // 主路由
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '主模型路由'),
          models.providersError
            ? h(Notice, { kind: 'err' }, models.providersError)
            : null,
          providers.length === 0 && !models.providersError
            ? h(Notice, null, '宿主没有注册任何 provider。装一个模型插件（例如 dsh-our-free-model）后这里会出现选项。')
            : null,
          h('div', { className: 'grid2' },
            h(Field, { label: 'Provider' },
              h('select', {
                value: prov,
                onChange: e => { setProv(e.target.value); setModel('') },
              },
                h('option', { value: '' }, '（未设置）'),
                providers.map(p => h('option', { key: p.id, value: p.id }, p.displayName || p.id)),
                // 配置里的 provider 可能已卸载，仍然要能看见它
                prov && !providers.some(p => p.id === prov)
                  ? h('option', { key: prov, value: prov }, prov + '（当前配置，未注册）')
                  : null,
              )),
            h(Field, { label: 'Model' },
              h(ModelPicker, { provider: prov, value: model, onChange: setModel })),
          ),
          h(Field, { label: '推理强度', sub: 'high 更慢更仔细' },
            h('select', { value: effort, onChange: e => setEffort(e.target.value) },
              ['minimal', 'low', 'medium', 'high', 'max'].map(x =>
                h('option', { key: x, value: x }, x)))),

          h(SwitchRow, {
            label: '同时设为 DSH 默认模型',
            desc: '同步给宿主 agentDefaultModel，避免两边不一致',
            on: syncHost, onChange: setSyncHost,
          }),

          h('div', { className: 'row' },
            h('button', { className: 'primary', disabled: !!busy || !prov || !model, onClick: applyMain }, '应用'),
            busy ? h('span', { className: 'hint' }, h('span', { className: 'spin' })) : null,
            hostSel
              ? h('span', { className: 'muted', style: { marginLeft: 'auto' } },
                  `宿主默认 ${hostSel.provider || '(无)'} / ${hostSel.model || '(无)'}` +
                  (hostSel.reasoningEffort ? ` · ${hostSel.reasoningEffort}` : ''))
              : null,
          ),
        ),

        // 降级链
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '降级链',
            h('span', { className: 'muted', style: { fontWeight: 400, marginLeft: 'auto' } },
              '主路由连续失败后按顺序切换')),
          h(SwitchRow, {
            label: '启用自动降级',
            desc: '连续失败 N 次切下一条，冷却后再试回主路由',
            on: cfg.dsh?.failover?.enabled !== false,
            onChange: v => saveConfig({ dsh: { failover: { enabled: v } } }),
          }),
          h('div', { className: 'grid2', style: { marginBottom: 12 } },
            h(Field, { label: '连续失败几次才切',  },
              h(NumberInput, {
                value: cfg.dsh?.failover?.consecutiveFailures ?? 2, min: 1, max: 10,
                onCommit: v => saveConfig({ dsh: { failover: { consecutiveFailures: v } } }),
              })),
            h(Field, { label: '冷却多久后尝试切回（分钟）' },
              h(NumberInput, {
                value: Math.round((cfg.dsh?.failover?.cooldownMs ?? 300000) / 60000), min: 1, max: 1440,
                onCommit: v => saveConfig({ dsh: { failover: { cooldownMs: v * 60000 } } }),
              })),
          ),

          routes.length === 0
            ? h('div', { className: 'muted', style: { padding: '4px 0' } },
                '还没有降级路由。主路由挂了会直接报错，建议至少加一条。')
            : h('div', { className: 'chain' },
                routes.map((r, i) => h('div', { key: i, className: 'chain-item' },
                  h('span', { className: 'idx' }, String(i + 1)),
                  h('div', { className: 'pm', title: `${r.provider}/${r.model || '(未填 model)'}` },
                    r.provider || '(未选 provider)', ' / ', r.model || '(未填 model)'),
                  h('button', { className: 'tiny', disabled: i === 0, onClick: () => moveRoute(i, -1) }, '↑'),
                  h('button', { className: 'tiny', disabled: i === routes.length - 1, onClick: () => moveRoute(i, 1) }, '↓'),
                  h('button', { className: 'tiny danger', onClick: () => removeRoute(i) }, '删'),
                )),
              ),
          h('div', { className: 'row', style: { marginTop: 10 } },
            h('button', {
              disabled: providers.length === 0,
              onClick: addRoute,
            }, '+ 添加一条降级路由'),
            providers.length === 0
              ? h('span', { className: 'hint' }, '没有可用 provider（先装模型插件）')
              : null,
          ),

          // 草稿行：还没保存的新路由。填完 provider+model 点「加入」才落盘。
          drafts.length > 0 ? h('div', { style: { marginTop: 4 } },
            h('div', { className: 'muted', style: { marginBottom: 6 } }, '待填写（两边都填完点「加入」才保存）：'),
            drafts.map((d, i) => h('div', {
              key: 'draft' + i,
              className: 'grid2',
              style: { marginBottom: 8, padding: 10, border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: 8 },
            },
              h(Field, { label: 'provider' },
                h('select', {
                  value: d.provider || '',
                  onChange: e => changeDraftProvider(i, e.target.value),
                },
                  h('option', { value: '' }, '（选 provider）'),
                  providers.map(p => h('option', { key: p.id, value: p.id }, p.displayName || p.id)),
                )),
              h(Field, { label: 'model' },
                h(ModelPicker, { provider: d.provider, value: d.model || '', onChange: v => updateDraft(i, { model: v }) })),
              (d.provider && d.model)
                ? h('div', { className: 'row' },
                    h('button', { className: 'primary tiny', onClick: () => commitDraft(i) }, '加入降级链'),
                    h('button', { className: 'tiny', onClick: () => removeDraft(i) }, '取消'),
                  )
                : h('div', { className: 'hint' },
                    'provider 和 model 都填了才能加入（半填的状态在运行时不会生效，所以不让存）'),
            )),
          ) : null,

          routes.length > 0 ? h(Collapse, { title: '逐条编辑已有路由' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              routes.map((r, i) => h('div', { key: 'edit' + i, className: 'grid2' },
                h(Field, { label: `第 ${i + 1} 条 provider` },
                  h('select', {
                    value: r.provider || '',
                    onChange: e => changeRouteProvider(i, e.target.value),
                  },
                    h('option', { value: '' }, '（选 provider）'),
                    providers.map(p => h('option', { key: p.id, value: p.id }, p.displayName || p.id)),
                    r.provider && !providers.some(p => p.id === r.provider)
                      ? h('option', { key: r.provider, value: r.provider }, r.provider + '（未注册）')
                      : null,
                  )),
                h(Field, { label: 'model' },
                  h(ModelPicker, { provider: r.provider, value: r.model || '', onChange: v => updateRoute(i, { model: v }) })),
              )),
            ),
          ) : null,
        ),
      )
    }

    // ── 行为页 ──────────────────────────────────────────────────────────────
    // ── MiniMax 模型/音色清单（与 lib/store.js 的 MINIMAX_* 保持一致）────────
    // 为什么在 client 里也写一份：client bundle 是独立打包的，require 只认
    // 宿主预注入的包，拿不到我们自己 lib/store.js 的导出。
    // ⚠️ 改这里时记得同步 lib/store.js（两边都改）。
    const MM_MODELS = [
      ['speech-2.5-hd-preview', 'speech-2.5-hd-preview（最新 HD，韵律最佳）'],
      ['speech-2.5-turbo-preview', 'speech-2.5-turbo-preview（最新 Turbo，40 语种）'],
      ['speech-02-hd', 'speech-02-hd（韵律/复刻最稳）'],
      ['speech-02-turbo', 'speech-02-turbo（小语种更强，快）'],
      ['speech-01-hd', 'speech-01-hd（复刻相似度高）'],
      ['speech-01-turbo', 'speech-01-turbo（更快）'],
    ]
    const MM_VOICES = [
      ['female-shaonv', '少女音色'],
      ['female-yujie', '御姐音色'],
      ['female-chengshu', '成熟女性'],
      ['female-tianmei', '甜美女性'],
      ['male-qn-qingse', '青涩青年'],
      ['male-qn-jingying', '精英青年'],
      ['male-qn-badao', '霸道青年'],
      ['male-qn-daxuesheng', '青年大学生'],
      ['lovely_girl', '萌萌女童'],
      ['cute_boy', '可爱男童'],
      ['clever_boy', '聪明男童'],
      ['qiaopi_mengmei', '俏皮萌妹'],
      ['tianxin_xiaoling', '甜心小玲'],
      ['diadia_xuemei', '嗲嗲学妹'],
      ['danya_xuejie', '淡雅学姐'],
      ['wumei_yujie', '妩媚御姐'],
      ['bingjiao_didi', '病娇弟弟'],
      ['junlang_nanyou', '俊朗男友'],
      ['chunzhen_xuedi', '纯真学弟'],
      ['lengdan_xiongzhang', '冷淡学长'],
      ['badao_shaoye', '霸道少爷'],
      ['presenter_male', '男性主持人'],
      ['presenter_female', '女性主持人'],
      ['audiobook_male_1', '男性有声书1'],
      ['audiobook_female_1', '女性有声书1'],
      ['Charming_Lady', 'Charming Lady（英文）'],
      ['Sweet_Girl', 'Sweet Girl（英文）'],
      ['Cute_Elf', 'Cute Elf（英文）'],
    ]
    const MM_EMOTIONS = [
      ['', '（不指定，模型自动判断）'],
      ['happy', '高兴'], ['sad', '悲伤'], ['angry', '愤怒'],
      ['fearful', '害怕'], ['disgusted', '厌恶'], ['surprised', '惊讶'],
      ['calm', '中性'],
    ]

    function BehaviorTab ({ cfg, saveConfig, env, data }) {
      const p = cfg.policy || {}
      const f = cfg.features || {}
      const tts = cfg.tts || {}
      // 🔴 2026-10-31 修：语音卡片的 API Key 输入要用 data.secrets 判断「已设置」，
      //   之前这个组件没接 data → render 时 ReferenceError: secrets is not defined
      //   → 整个「行为」Tab 白屏（React 抛错后不再渲染子树）。
      const secrets = data?.secrets || {}
      // 在线 TTS 的「拉取模型」状态。
      // ⚠️ 这些必须在组件顶部声明：上次就是漏了 secrets 这一个，整个 Tab 白屏。
      const [pulling, setPulling] = useState(false)
      const [pullMsg, setPullMsg] = useState('')
      const [mmModelList, setMmModelList] = useState([])
      const [mmAllIds, setMmAllIds] = useState([])

      const listToText = a => Array.isArray(a) ? a.join('\n') : ''
      const textToList = t => String(t).split(/[\s,，]+/).map(x => x.trim()).filter(Boolean)

      return h(React.Fragment, null,
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '谁会得到回复'),
          h(SwitchRow, {
            label: '响应私聊',
            on: p.allowC2C !== false,
            onChange: v => saveConfig({ policy: { allowC2C: v } }),
          }),
          h(SwitchRow, {
            label: '群里必须 @ 才回复',
            desc: '关掉它会响应群里所有消息（容易被嫌吵）',
            on: p.requireAtInGroup !== false,
            onChange: v => saveConfig({ policy: { requireAtInGroup: v } }),
          }),
          h(Field, { label: '用户白名单', sub: '填「对方」的号，不是机器人自己的号。留空 = 不限制' },
            h(TextAreaCommit, {
              value: listToText(p.allowUsers),
              onCommit: v => saveConfig({ policy: { allowUsers: textToList(v) } }),
              placeholder: '1000000001\n1000000002',
            })),
          h(Field, { label: '群白名单', sub: '一行一个群号。留空 = 不限制' },
            h(TextAreaCommit, {
              value: listToText(p.allowGroups),
              onCommit: v => saveConfig({ policy: { allowGroups: textToList(v) } }),
              placeholder: '2000000001',
            })),
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '说话方式'),
          h('div', { className: 'grid2' },
            h(Field, { label: '单条最大字数', sub: '超出会拆成几条' },
              h(NumberInput, {
                value: p.maxReplyChars ?? 1500, min: 50, max: 5000,
                onCommit: v => saveConfig({ policy: { maxReplyChars: v } }),
              })),
            h(Field, { label: '连发间隔（毫秒）' },
              h(NumberInput, {
                value: p.replyChunkDelayMs ?? 400, min: 0, max: 5000,
                onCommit: v => saveConfig({ policy: { replyChunkDelayMs: v } }),
              })),
          ),
          h(Field, { label: '同一人最小回复间隔（毫秒）', sub: '防止对方连发时也跟着刷屏' },
            h(NumberInput, {
              value: p.cooldownMsPerPeer ?? 1500, min: 0, max: 60000,
              onCommit: v => saveConfig({ policy: { cooldownMsPerPeer: v } }),
            })),
          h(Field, { label: '时区' },
            h(TextInput, {
              value: p.timezone ?? 'Asia/Shanghai',
              onCommit: v => saveConfig({ policy: { timezone: v } }),
            })),
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '免打扰时段'),
          h(SwitchRow, {
            label: '启用静默时段',
            desc: '这段时间里不主动说话',
            on: p.quietHours?.enabled === true,
            onChange: v => saveConfig({ policy: { quietHours: { enabled: v } } }),
          }),
          p.quietHours?.enabled ? h('div', { className: 'grid2' },
            h(Field, { label: '从几点（0-23）' },
              h(NumberInput, {
                value: p.quietHours?.startHour ?? 1, min: 0, max: 23,
                onCommit: v => saveConfig({ policy: { quietHours: { startHour: v } } }),
              })),
            h(Field, { label: '到几点（0-23）' },
              h(NumberInput, {
                value: p.quietHours?.endHour ?? 7, min: 0, max: 23,
                onCommit: v => saveConfig({ policy: { quietHours: { endHour: v } } }),
              })),
          ) : null,
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '能力开关',
            h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } },
              '关掉的不会出现在 agent 上下文里')),
          h(SwitchRow, {
            label: '戳一戳 [POKE:]',
            on: f.poke !== false,
            onChange: v => saveConfig({ features: { poke: v } }),
          }),
          h(SwitchRow, {
            label: '撤回 [RECALL:]',
            on: f.recall !== false,
            onChange: v => saveConfig({ features: { recall: v } }),
          }),
          h(SwitchRow, {
            label: '补一句 [FOLLOW:]',
            on: f.follow !== false,
            onChange: v => saveConfig({ features: { follow: v } }),
          }),
          h(SwitchRow, {
            label: '语音 [VOICE:]',
            desc: '需要本机 TTS 服务',
            on: f.voice === true,
            onChange: v => saveConfig({ features: { voice: v } }),
          }),
          h(SwitchRow, {
            label: '入群欢迎',
            on: f.welcome === true,
            onChange: v => saveConfig({ features: { welcome: v } }),
          }),
          h(SwitchRow, {
            label: 'B站工具',
            desc: '让模型能搜视频 / 拉字幕 / 看评论',
            on: f.bili === true,
            onChange: v => saveConfig({ features: { bili: v } }),
          }),
          // 开关是「要不要用它」，这里是「它到底挂没挂上」——两件事。
          // 只有 features.bili 打开、MCP 也挂上，模型才真的拿得到 bili_* 工具。
          h(SwitchRow, {
            label: 'B站工具（MCP）',
            desc: '挂插件自带的 bilibili MCP；缺依赖可在下面一键装，改完要重启桥',
            on: cfg.mcp?.bili?.enabled === true,
            onChange: v => saveConfig({ mcp: { bili: { enabled: v } } }),
          }),
          // 只有 features.bili 打开、MCP 也真挂上，模型才拿得到 bili_* 工具 ——
          // 所以状态与「装依赖」必须常驻可见（挂上了也留一个入口，方便换 venv/重装），
          // 否则用户会以为「开了开关就等于能用」或者干脆找不到这个按钮。
          (() => {
            const bili = env?.capabilities?.mcp?.bili
            if (!bili) return null
            const title = bili.ok
              ? 'B站工具已就绪 · 换 venv / 重装依赖'
              : 'B站工具没挂上 · 点这里装依赖'
            return h(Collapse, { title },
              h(BiliSetup, { bili }),
            )
          })(),
          h(SwitchRow, {
            label: '自我风格样本库',
            desc: '记住「我类似场合怎么说的」，保持人格一致',
            on: f.style === true,
            onChange: v => saveConfig({ features: { style: v } }),
          }),
          h(SwitchRow, {
            label: '说话方式学习',
            desc: '学群里的词汇/梗，会定期跑模型，费额度',
            on: f.learning === true,
            onChange: v => saveConfig({ features: { learning: v } }),
          }),
        ),

        // ── 语音（TTS）────────────────────────────────────────────────────
        // 为什么要单独一张卡：features.voice 只是「要不要用语音」，
        // 真正出声还得知道「用哪个引擎、连哪个地址、用哪段参考音频」。
        // 之前这些字段完全没暴露 → 用户开了语音开关也只能靠默认值碰运气。
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '语音（TTS）',
            h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } },
              '[VOICE:] 用哪个引擎出声')),
          h(SwitchRow, {
            label: '启用语音',
            desc: '关掉后 [VOICE:] 自动降级为文字',
            on: tts.enabled === true,
            onChange: v => saveConfig({ tts: { enabled: v }, features: { voice: v } }),
          }),
          tts.enabled ? h(React.Fragment, null,
            h(Field, { label: '引擎', sub: '本机 TTS 要装模型；在线 API 只要一个 key' },
              h('select', {
                value: tts.engine || 'gsv',
                onChange: e => saveConfig({ tts: { engine: e.target.value } }),
                style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
              },
                h('option', { value: 'gsv' }, 'GPT-SoVITS（本机 · 音色克隆）'),
                h('option', { value: 'openai' }, '在线 API（OpenAI 兼容 /audio/speech）'),
                h('option', { value: 'minimax' }, 'MiniMax 语音（国内直连 · 29 音色 · 情绪）'),
                h('option', { value: 'piper' }, 'Piper（本机 · 轻量）'),
                h('option', { value: 'sherpa' }, 'sherpa-onnx（本机）'),
                h('option', { value: 'qq' }, 'QQ 内置音色（仅群聊 · 机械音）'),
              )),
            h('div', { className: 'grid2' },
              h(Field, { label: '单条上限（字）', sub: '超出截断' },
                h(NumberInput, {
                  value: tts.maxChars ?? 200, min: 20, max: 2000,
                  onCommit: v => saveConfig({ tts: { maxChars: v } }),
                })),
            ),

            // ── GPT-SoVITS 字段 ──
            (tts.engine || 'gsv') === 'gsv' ? h(React.Fragment, null,
              h(Field, { label: 'GPT-SoVITS 地址', sub: '默认 http://127.0.0.1:9880/' },
                h(TextInput, {
                  value: tts.gsv?.url || 'http://127.0.0.1:9880/',
                  placeholder: 'http://127.0.0.1:9880/',
                  onCommit: v => saveConfig({ tts: { gsv: { url: v } } }),
                })),
              h(Field, { label: '参考音频（音色克隆）',
                sub: '留空 = 用服务端启动时的默认参考。填了就是「用这个声音说话」' },
                h(TextInput, {
                  value: tts.gsv?.referWav || '',
                  placeholder: '/path/to/reference.wav',
                  onCommit: v => saveConfig({ tts: { gsv: { referWav: v } } }),
                })),
              h(Field, { label: '参考音频对应的文本', sub: '必须和参考音频内容一致，否则音色会跑偏' },
                h(TextInput, {
                  value: tts.gsv?.promptText || '',
                  placeholder: '我是吉祥物，以后就用这个声音说话啦',
                  onCommit: v => saveConfig({ tts: { gsv: { promptText: v } } }),
                })),
              h('div', { className: 'grid2' },
                h(Field, { label: '语速' },
                  h(NumberInput, {
                    value: tts.gsv?.speed ?? 1.0, min: 0.5, max: 2.0, step: 0.05,
                    onCommit: v => saveConfig({ tts: { gsv: { speed: v } } }),
                  })),
                h(Field, { label: '温度（越高越有起伏）' },
                  h(NumberInput, {
                    value: tts.gsv?.temperature ?? 1.0, min: 0.1, max: 2.0, step: 0.05,
                    onCommit: v => saveConfig({ tts: { gsv: { temperature: v } } }),
                  })),
              ),
            ) : null,

            // ── 在线 API 字段 ──
            tts.engine === 'openai' ? h(React.Fragment, null,
              h(Notice, { kind: 'info' },
                '任何实现了 POST /audio/speech 的服务都能用：OpenAI、硅基流动、Azure、自建网关等。'),
              h(Field, { label: '接口地址', sub: '默认 https://api.openai.com/v1/audio/speech' },
                h(TextInput, {
                  value: tts.openai?.url || '',
                  placeholder: 'https://api.openai.com/v1/audio/speech',
                  onCommit: v => saveConfig({ tts: { openai: { url: v } } }),
                })),
              h(Field, { label: 'API Key', sub: '建议写在凭据里（不进 bridge-config.json 明文）' },
                h(SecretInput, { field: 'ttsApiKey', filled: secrets?.ttsApiKey, placeholder: 'sk-...' })),
              h('div', { className: 'grid2' },
                h(Field, { label: '模型', sub: '可手填，也可点右边「拉取」从服务拿真实清单' },
                  h(React.Fragment, null,
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('input', {
                        type: 'text',
                        value: mmModelList.length ? (tts.openai?.model || 'tts-1') : (tts.openai?.model || 'tts-1'),
                        placeholder: 'tts-1 / tts-1-hd / 服务商自定义',
                        onChange: e => saveConfig({ tts: { openai: { model: e.target.value } } }),
                        style: { flex: 1, padding: '6px 8px', borderRadius: 6 },
                        list: 'llminqq-tts-models',
                      }),
                      h('button', {
                        className: 'tiny',
                        disabled: pulling,
                        onClick: async () => {
                          setPulling(true); setPullMsg('')
                          try {
                            const r = await post('/tts/openai-models', {
                              url: tts.openai?.url || '',
                            })
                            if (r.ok && Array.isArray(r.models)) {
                              setMmModelList(r.models)
                              setPullMsg(r.models.length
                                ? `拿到 ${r.models.length} 个语音模型（共 ${r.total} 个）`
                                : `没找到像语音模型的 id（共 ${r.total} 个），见下方清单`)
                              if (r.allIds?.length) setMmAllIds(r.allIds)
                            } else {
                              setPullMsg('拉取失败：' + (r.reason || '未知'))
                            }
                          } catch (e) {
                            setPullMsg('拉取失败：' + e.message)
                          } finally {
                            setPulling(false)
                          }
                        },
                      }, pulling ? '拉取中…' : '↻ 拉取'),
                    ),
                    mmModelList.length ? h('datalist', { id: 'llminqq-tts-models' },
                      ...mmModelList.map(id => h('option', { key: id, value: id }))) : null,
                    pullMsg ? h('div', { className: 'muted', style: { marginTop: 4 } }, pullMsg) : null,
                    (mmAllIds.length && !mmModelList.length)
                      ? h('div', { className: 'muted', style: { marginTop: 4, maxHeight: 90, overflow: 'auto', fontSize: 11 } },
                          '可用 id（点一个填入）：',
                          ...mmAllIds.slice(0, 60).map(id =>
                            h('span', {
                              key: id,
                              style: { cursor: 'pointer', marginLeft: 6, textDecoration: 'underline' },
                              onClick: () => saveConfig({ tts: { openai: { model: id } } }),
                            }, id)))
                      : null,
                  )),
                h(Field, { label: '音色', sub: 'alloy / nova / shimmer / echo / fable / onyx / 服务商自定义' },
                  h(TextInput, {
                    value: tts.openai?.voice || 'alloy',
                    placeholder: 'alloy / nova / shimmer / 自定义',
                    onCommit: v => saveConfig({ tts: { openai: { voice: v } } }),
                  })),
              ),
              h('div', { className: 'grid2' },
                h(Field, { label: '输出格式', sub: 'mp3 / opus / wav' },
                  h('select', {
                    value: tts.openai?.format || 'mp3',
                    onChange: e => saveConfig({ tts: { openai: { format: e.target.value } } }),
                    style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
                  },
                    h('option', { value: 'mp3' }, 'mp3'),
                    h('option', { value: 'opus' }, 'opus'),
                    h('option', { value: 'wav' }, 'wav'),
                    h('option', { value: 'aac' }, 'aac'),
                  )),
                h(Field, { label: '语速' },
                  h(NumberInput, {
                    value: tts.openai?.speed ?? 1.0, min: 0.5, max: 2.0, step: 0.05,
                    onCommit: v => saveConfig({ tts: { openai: { speed: v } } }),
                  })),
              ),
            ) : null,

            // ── MiniMax 字段 ──
            tts.engine === 'minimax' ? h(React.Fragment, null,
              h(Notice, { kind: 'info' },
                '从 platform.minimaxi.com 拿 API Key 和 GroupId。音色 29 种，部分模型支持情绪。'),
              h(Field, { label: '接口地址', sub: '国内 https://api.minimaxi.com/v1/t2a_v2' },
                h(TextInput, {
                  value: tts.minimax?.url || '',
                  placeholder: 'https://api.minimaxi.com/v1/t2a_v2',
                  onCommit: v => saveConfig({ tts: { minimax: { url: v } } }),
                })),
              h('div', { className: 'grid2' },
                h(Field, { label: 'API Key', sub: '存进 secrets，不进明文配置' },
                  h(SecretInput, { field: 'ttsMinimaxKey', filled: secrets?.ttsMinimaxKey, placeholder: '填 MiniMax API Key' })),
                h(Field, { label: 'GroupId', sub: 'MiniMax 控制台里那一串' },
                  h(TextInput, {
                    value: tts.minimax?.groupId || '',
                    placeholder: 'GroupId',
                    onCommit: v => saveConfig({ tts: { minimax: { groupId: v } } }),
                  })),
              ),
              h(Field, { label: '模型', sub: '音质和速度的取舍' },
                h('select', {
                  value: tts.minimax?.model || 'speech-2.5-hd-preview',
                  onChange: e => saveConfig({ tts: { minimax: { model: e.target.value } } }),
                  style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
                }, ...MM_MODELS.map(([v, lbl]) => h('option', { key: v, value: v }, lbl))),
              ),
              h(Field, { label: '音色', sub: '29 种可选；想用自己复刻的音色就手填 id' },
                h('select', {
                  value: tts.minimax?.voiceId || 'female-shaonv',
                  onChange: e => saveConfig({ tts: { minimax: { voiceId: e.target.value } } }),
                  style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
                }, ...MM_VOICES.map(([v, lbl]) => h('option', { key: v, value: v }, lbl + '（' + v + '）'))),
              ),
              h(Field, { label: '自定义音色 id', sub: '留空 = 用上面选的；填了就覆盖（复刻音色用这里）' },
                h(TextInput, {
                  value: tts.minimax?.voiceIdCustom || '',
                  placeholder: '比如你复刻出来的 voice_id',
                  onCommit: v => saveConfig({ tts: { minimax: { voiceIdCustom: v } } }),
                })),
              h('div', { className: 'grid2' },
                h(Field, { label: '情绪', sub: '仅部分模型生效' },
                  h('select', {
                    value: tts.minimax?.emotion || '',
                    onChange: e => saveConfig({ tts: { minimax: { emotion: e.target.value } } }),
                    style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
                  }, ...MM_EMOTIONS.map(([v, lbl]) => h('option', { key: v || 'none', value: v }, lbl))),
                ),
                h(Field, { label: '语速', sub: '0.5 ~ 2.0' },
                  h(NumberInput, {
                    value: tts.minimax?.speed ?? 1.0, min: 0.5, max: 2.0, step: 0.05,
                    onCommit: v => saveConfig({ tts: { minimax: { speed: v } } }),
                  })),
              ),
              h('div', { className: 'grid2' },
                h(Field, { label: '音调', sub: '-12 ~ 12，0 = 原音' },
                  h(NumberInput, {
                    value: tts.minimax?.pitch ?? 0, min: -12, max: 12, step: 1,
                    onCommit: v => saveConfig({ tts: { minimax: { pitch: v } } }),
                  })),
                h(Field, { label: '输出格式' },
                  h('select', {
                    value: tts.minimax?.format || 'mp3',
                    onChange: e => saveConfig({ tts: { minimax: { format: e.target.value } } }),
                    style: { width: '100%', padding: '6px 8px', borderRadius: 6 },
                  },
                    h('option', { value: 'mp3' }, 'mp3'),
                    h('option', { value: 'wav' }, 'wav'),
                    h('option', { value: 'flac' }, 'flac'),
                  )),
              ),
            ) : null,

            // ── Piper 字段 ──
            tts.engine === 'piper' ? h(Field, { label: 'Piper 地址', sub: '默认 http://127.0.0.1:5006/synthesize' },
              h(TextInput, {
                value: tts.piper?.url || '',
                placeholder: 'http://127.0.0.1:5006/synthesize',
                onCommit: v => saveConfig({ tts: { piper: { url: v } } }),
              })) : null,

            // ── sherpa 字段 ──
            tts.engine === 'sherpa' ? h(Field, { label: 'sherpa 地址', sub: '默认 http://127.0.0.1:9881/synthesize' },
              h(TextInput, {
                value: tts.sherpa?.url || '',
                placeholder: 'http://127.0.0.1:9881/synthesize',
                onCommit: v => saveConfig({ tts: { sherpa: { url: v } } }),
              })) : null,

            tts.engine === 'qq' ? h(Notice, { kind: 'warn' },
              'QQ 内置音色只有群聊能用，私聊会降级为文字；声音是机械音，不是你自己的音色。') : null,
          ) : null,
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '主动发言',
            h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } },
              '不等你开口，自己找话题')),
          h(Notice, { kind: 'warn' }, '没配白名单不会启动。'),
          h(SwitchRow, {
            label: '启用主动发言',
            on: f.proactive === true,
            onChange: v => saveConfig({ features: { proactive: v } }),
          }),
          f.proactive ? h(React.Fragment, null,
            h(Field, { label: '主动找谁（白名单，一行一个 QQ 号）', sub: '只对这些人主动说话。留空 = 不启用' },
              h(TextAreaCommit, {
                value: listToText(cfg.proactive?.whitelist),
                onCommit: v => saveConfig({ proactive: { whitelist: textToList(v) } }),
                placeholder: '1000000001',
              })),
            h('div', { className: 'grid2' },
              h(Field, { label: '基础概率' },
                h(NumberInput, {
                  value: cfg.proactive?.baseProb ?? 0.1, min: 0, max: 1,
                  onCommit: v => saveConfig({ proactive: { baseProb: v } }),
                })),
              h(Field, { label: '冷却分钟' },
                h(NumberInput, {
                  value: cfg.proactive?.cooldownMin ?? 40, min: 1, max: 1440,
                  onCommit: v => saveConfig({ proactive: { cooldownMin: v } }),
                })),
            ),
          ) : null,
        ),
      )
    }

    function TextAreaCommit ({ value, onCommit, placeholder }) {
      const [local, setLocal] = useState(value ?? '')
      const focused = useRef(false)
      useEffect(() => { if (!focused.current) setLocal(value ?? '') }, [value])
      return h('textarea', {
        value: local,
        placeholder,
        onFocus: () => { focused.current = true },
        onChange: e => setLocal(e.target.value),
        onBlur: () => { focused.current = false; if (local !== (value ?? '')) onCommit(local) },
      })
    }

    // ── 人格页 ──────────────────────────────────────────────────────────────
    function PersonaTab ({ run, setMsg }) {
      const [text, setText] = useState('')
      const [path, setPath] = useState('')
      const [loading, setLoading] = useState(true)
      const [dirty, setDirty] = useState(false)
      // 读失败时锁住编辑/保存：否则文本框是空的，用户一保存就把原人设覆盖成空
      const [loadError, setLoadError] = useState('')

      useEffect(() => {
        api('/persona').then(r => {
          if (r.ok) { setText(r.text || ''); setPath(r.path || '') }
          else {
            setLoadError(r.error || '读不到人设')
            setMsg({ kind: 'err', text: `读不到人设：${r.error || '未知错误'}（已禁止保存，避免覆盖原文件）` })
          }
        }).catch(err => {
          setLoadError(err?.message || String(err))
          setMsg({ kind: 'err', text: `读不到人设：${err?.message || err}（已禁止保存，避免覆盖原文件）` })
        }).finally(() => setLoading(false))
      }, [setMsg])

      const save = () => run('save-persona', async () => {
        const r = await post('/persona', { text })
        if (r.ok) { setDirty(false); setMsg({ kind: 'ok', text: `已保存（${r.bytes} 字节）。下一轮就生效，不用重启` }) }
        return r
      })

      if (loading) return h('div', { className: 'hint' }, h('span', { className: 'spin' }), ' 读取中…')

      return h('div', { className: 'card' },
        h('div', { className: 'card-title' }, '人格文件',
          h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } },
            `${byteLenOf(text)} 字节`)),
        loadError
          ? h('div', { className: 'hint', style: { color: 'var(--danger, #d33)' } },
              `读取失败：${loadError}。为避免把原文件覆盖成空内容，编辑和保存已禁用；修好文件权限后重新打开本页。`)
          : h('div', { className: 'hint' }, '模型自己也会改这份文件，看到的内容可能和上次不同。每次保存会留一份 .bak。'),
        h('div', { className: 'mono', style: { color: 'var(--qq-2)', wordBreak: 'break-all' } }, path),
        h('textarea', {
          value: text,
          disabled: !!loadError,
          onChange: e => { setText(e.target.value); setDirty(true) },
          style: { minHeight: 320, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, lineHeight: 1.6 },
        }),
        h('div', { className: 'row' },
          h('button', { className: 'primary', disabled: !dirty || !!loadError, onClick: save }, '保存'),
          h('button', { className: 'tiny', disabled: !!loadError, onClick: () => { setText(text); setDirty(false) } }, '放弃修改'),
          dirty ? h('span', { className: 'muted', style: { marginLeft: 'auto' } }, '有未保存的修改') : null,
        ),
      )
    }

    // ── 记忆页（第四期：看条数 / 按人分布 / 清除某人 / 备份恢复）─────────────
    //
    // 为什么这个页要有「清除」和「导出」两个危险按钮的独立确认流程：
    //   清除记忆是不可逆的（用户攒几个月才有这 800 多条），而设置页的按钮
    //   很容易手滑点到。所以：
    //     ① 清某人 → 先调 dryRun 查影响面，弹出「会删 N 条」再确认
    //     ② 清全部 → 必须**手打确认词** DELETE-ALL（不是勾选框，勾选框会手滑）
    //   后端也独立校验（不靠前端拦，见 lib/agent/memory-admin.mjs 文件头 ②）。
    function MemoryTab ({ run, setMsg }) {
      const [stats, setStats] = useState(null)
      const [recent, setRecent] = useState(null)
      const [loading, setLoading] = useState(true)
      const [clearOwner, setClearOwner] = useState('')
      const [confirmAll, setConfirmAll] = useState('')
      const [pending, setPending] = useState(null)   // {owner, wouldDelete}
      const [exportList, setExportList] = useState(null)
      const [importing, setImporting] = useState(false)

      const load = useCallback(async () => {
        const r = await api('/memory/stats')
        setStats(r)
        const l = await api('/memory/export/list')
        if (l.ok) setExportList(l)
        setLoading(false)
      }, [])
      useEffect(() => { load() }, [load])

      const loadRecent = useCallback(async () => {
        const r = await api('/memory/recent?limit=20')
        setRecent(r.rows || [])
        if (!r.ok) setMsg({ kind: 'err', text: r.reason || '读不到最近记忆' })
      }, [setMsg])

      // ① 先算影响面（不删）
      const askClear = async (owner) => {
        setMsg(null)
        const r = await post('/memory/clear?dryRun=1', { owner: owner || '', confirm: true })
        if (!r.ok) { setMsg({ kind: 'err', text: r.error || '查询失败' }); return }
        setPending({ owner: owner || '', wouldDelete: r.wouldDelete })
      }

      // ② 真删（清某人：pending 里带着 owner；清全部：必须确认词）
      const doClear = async () => {
        const body = pending.owner
          ? { owner: pending.owner, confirm: true }
          : { owner: '', confirm: true, confirmText: confirmAll }
        const r = await post('/memory/clear', body)
        if (r.ok) {
          setMsg({
            kind: 'ok',
            text: `${r.all ? '全部记忆' : `「${r.owner}」的 ${r.deleted} 条记忆`}已归档`
              + (r.backup ? `（清除前已备份为 ${r.backup}）` : ''),
          })
          setPending(null); setClearOwner(''); setConfirmAll('')
          setRecent(null)
          await load()
        } else setMsg({ kind: 'err', text: r.error || '清除失败' })
      }

      const doExport = () => {
        setMsg(null)
        // 直接开浏览器下载（后端返回 zip 流）。用 a[href] 而不是 fetch：
        // fetch 拿到的是 blob，还要自己造 objectURL + 点一次，容易出错。
        const a = document.createElement('a')
        a.href = API + '/memory/export'
        a.rel = 'noopener'
        a.click()
        setMsg({ kind: 'ok', text: '已开始下载备份 zip（在浏览器的下载里）' })
      }

      const doImport = async (file) => {
        if (!file) return
        setImporting(true); setMsg(null)
        try {
          const r = await fetch(API + '/memory/import', { method: 'POST', body: file })
          const body = await r.json()
          if (body.ok) {
            setMsg({ kind: 'ok', text: `已恢复 ${body.restored.length} 个文件，共 ${body.total} 条记忆（导入前已备份为 ${body.backupDir}）` })
            setRecent(null)
            await load()
          } else setMsg({ kind: 'err', text: body.error || '导入失败' })
        } catch (e) {
          setMsg({ kind: 'err', text: '导入失败：' + e.message })
        } finally { setImporting(false) }
      }

      if (loading) return h('div', { className: 'hint' }, h('span', { className: 'spin' }), ' 读取记忆统计…')
      if (!stats) return h(Notice, { kind: 'err' }, '读不到记忆统计')

      const state = stats.ok ? (stats.dbExists ? 'ok' : 'degraded') : 'off'
      const kb = (stats.dbSizeBytes || 0) / 1024
      const sizeText = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB'

      return h(React.Fragment, null,
        // ── 概览 ────────────────────────────────────────────────────────────
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '记忆库',
            h(Badge, { kind: state === 'ok' ? 'ok' : state === 'degraded' ? 'warn' : 'bad' },
              state === 'ok' ? '就绪' : state === 'degraded' ? '空库' : '不可用'),
            h('span', { className: 'hint', style: { marginLeft: 'auto', fontWeight: 400 } },
              stats.ok
                ? `${stats.total} 条（有效 ${stats.alive}）· ${sizeText}`
                : (stats.reason || 'python 不可用')),
          ),
          !stats.ok
            ? h(Notice, { kind: 'err', title: '记忆功能不可用' }, stats.reason || '')
            : null,
          stats.ok && stats.empty
            ? h(Notice, { kind: 'warn', title: '还没有攒到记忆' },
                h('div', null, '桥会把它回过的对话写进这里。一条都没有，通常是消息根本没到模型手上 —— 先看这两条：'),
                h('ol', { style: { margin: '6px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.8 } },
                  h('li', null, '桥日志里如果一直是「忽略消息 … (allow 判定)」，是白名单没放行（注意白名单填的是**对方**的号）'),
                  h('li', null, '如果日志里有「本轮失败」，是模型路由或凭据的问题，桥不会写记忆'),
                ),
                h('div', { className: 'muted', style: { marginTop: 6 } }, `库文件：${stats.db || ''}（首次入库时才创建）`))
            : null,
          stats.ok && !stats.empty ? h(KV, {
            rows: [
              ['总数', `${stats.total} 条`, true],
              ['有效', `${stats.alive} 条`, stats.alive > 0],
              ['库大小', sizeText, true],
              ['未归属', `${stats.unowned} 条（群级/公共）`, true],
              ['位置', stats.stateDir, true],
              ['Python', stats.pythonOk ? (stats.pythonVersion || '可用') : '不可用', stats.pythonOk],
            ],
          }) : null,
        ),

        // ── 按层 / 按人 ──────────────────────────────────────────────────────
        stats.ok && !stats.empty ? h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '分布'),
          h('div', { className: 'sec-head' }, '按层'),
          h('div', { className: 'hint' },
            (stats.byLayer || []).map(l => `${l.kind} ${l.total}`).join(' · ')),
          (stats.byVisibility || []).length
            ? h('div', { className: 'hint' }, '可见性：' + stats.byVisibility.map(v => `${v.visibility} ${v.count}`).join(' · '))
            : null,
          h('hr', { className: 'divider' }),
          h('div', { className: 'sec-head' }, '按人（有效记忆）'),
          (stats.byOwner || []).length === 0
            ? h('div', { className: 'muted' }, '还没有按人归集的记忆')
            : h('div', { className: 'rows' },
              stats.byOwner.slice(0, 12).map(o => h('div', { className: 'row', key: o.owner },
                h('span', { className: 'mono' }, o.owner),
                h('span', { className: 'hint' }, `${o.count} 条`),
                h('button', {
                  className: 'tiny',
                  style: { marginLeft: 'auto' },
                  onClick: () => setClearOwner(o.owner),
                }, '清除'),
              )),
              stats.byOwner.length > 12
                ? h('div', { className: 'muted' }, `…共 ${stats.byOwner.length} 人`)
                : null,
            ),
        ) : null,

        // ── 查看最近 ────────────────────────────────────────────────────────
        stats.ok && !stats.empty ? h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '最近记忆',
            h('button', { className: 'tiny', style: { marginLeft: 'auto' }, onClick: loadRecent }, '查看最近 20 条')),
          recent === null
            ? h('div', { className: 'muted' }, '点上面按钮看看它到底记了些什么')
            : recent.length === 0
              ? h('div', { className: 'muted' }, '（没有记录）')
              : h('div', { className: 'rows' },
                recent.map((x, i) => h('div', { className: 'row', key: x.id || i, style: { alignItems: 'flex-start' } },
                  h('span', { className: 'muted mono', style: { flex: 'none' } }, x.kind),
                  h('span', { className: 'hint', style: { flex: 1, minWidth: 0, color: 'var(--qq-1)' } }, x.text),
                  x.owner ? h('span', { className: 'muted mono', style: { flex: 'none' } }, x.owner) : null,
                )),
              ),
        ) : null,

        // ── 清除（危险）─────────────────────────────────────────────────────
        stats.ok && !stats.empty ? h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '清除记忆',
            h('span', { className: 'hint', style: { marginLeft: 'auto', fontWeight: 400 } }, '不可逆，会先备份')),
          h('Notice', { kind: 'warn' },
            '清除是「归档」不是物理删除：检索和统计里立刻消失，但数据还在库里、清除前也会自动备份一份，可以恢复。'),

          h('div', { className: 'row' },
            h('div', { className: 'field', style: { flex: 1, minWidth: 180 } },
              h('label', null, '清除某个人（QQ 号）'),
              h('input', {
                type: 'text', value: clearOwner, placeholder: '例如 1000000001',
                onChange: e => setClearOwner(e.target.value),
              }),
            ),
            h('button', {
              disabled: !clearOwner.trim() || !!pending,
              onClick: () => askClear(clearOwner.trim()),
            }, '查看会删多少条'),
          ),

          // 清全部：必须手打确认词
          h('hr', { className: 'divider' }),
          h('div', { className: 'field' },
            h('label', null, '清空全部记忆（危险）'),
            h('div', { className: 'sub' }, '要输入确认词 DELETE-ALL。不是勾选框 —— 勾选框容易手滑。'),
            h('input', {
              type: 'text', value: confirmAll, placeholder: 'DELETE-ALL',
              onChange: e => setConfirmAll(e.target.value),
            }),
          ),
          h('div', { className: 'row' },
            h('button', {
              disabled: confirmAll !== 'DELETE-ALL',
              onClick: () => askClear(''),
            }, '查看全部条数'),
          ),

          // 确认弹窗（用内联块，不用 window.confirm —— 后者在某些宿主里被禁）
          pending ? h('Notice', { kind: 'err', title: '确认清除' },
            pending.owner
              ? `将从记忆里归档「${pending.owner}」的 ${pending.wouldDelete} 条。这个操作会先自动备份。`
              : `将归档**全部** ${pending.wouldDelete} 条记忆。这个操作会先自动备份。`,
            h('div', { className: 'row', style: { marginTop: 8 } },
              h('button', { className: 'primary', onClick: doClear }, '确认清除'),
              h('button', { className: 'tiny', onClick: () => setPending(null) }, '取消'),
            ),
          ) : null,
        ) : null,

        // ── 备份 / 恢复 ──────────────────────────────────────────────────────
        stats.ok ? h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '备份与恢复'),
          h('div', { className: 'hint' },
            '导出会打包记忆库、词库、语料池和日志（不含凭据）。换机器时用它迁移。'),
          exportList
            ? h('div', { className: 'muted' },
              `${exportList.files.length} 个文件 · 共 ${Math.round(exportList.totalBytes / 1024)} KB`)
            : null,
          h('div', { className: 'row' },
            h('button', { onClick: doExport, disabled: !stats.dbExists }, '导出备份 zip'),
            h('label', { className: 'tiny', style: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' } },
              importing ? '导入中…' : '导入备份',
              h('input', {
                type: 'file', accept: '.zip,application/zip', style: { display: 'none' },
                disabled: importing,
                onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; doImport(f) },
              }),
            ),
          ),
          h('div', { className: 'muted' },
            '导入前会自动把现有数据备份到 stateDir 下的 backup-before-import-* 目录，不会覆盖丢数据。'),
        ) : null,

        // ── B站语料抓取（第 ③ 项）────────────────────────────────────────────
        // 只做手动按钮：自动抓评论 = 风控风险放大（PLAN §9）。
        // 一天最多 3 次（后端限频，这里只负责把剩余次数显示出来）。
        h(CrawlCard, { setMsg }),
      )
    }

    // B站语料抓取卡片：显示剩余次数 / 依赖是否就绪 / 跑一次
    //
    // 为什么要单独一个组件（不塞进 MemoryTab 里）：它要自己轮询状态
    // （抓一次要几分钟），放在父组件里会让整页每次轮询都重渲染。
    function CrawlCard ({ setMsg }) {
      const [st, setSt] = useState(null)
      const [running, setRunning] = useState(false)

      const load = useCallback(async () => {
        const r = await api('/memory/crawl/status')
        if (r.ok) setSt(r)
      }, [])
      useEffect(() => { load() }, [load])

      const go = async () => {
        setRunning(true); setMsg(null)
        try {
          const r = await post('/memory/crawl', { only: 2 })
          if (r.ok) {
            // ⚠️ 别再拿 `?? '若干'` 兜底了 —— 那会让「一条没抓」也显示成
            //   「学到 若干 个词汇」，用户以为成功。宁可说清楚没抓到及原因。
            const got = Number(r.result?.fetched ?? 0) + Number(r.result?.files?.length ?? 0)
            const secs = Math.round((r.ms || 0) / 1000)
            if (r.note) {
              setMsg({ kind: 'warn', text: `${r.note}（用时 ${secs}s，未计次）` })
            } else if (got > 0) {
              setMsg({ kind: 'ok', text: `抓取完成：${got} 个视频，用时 ${secs}s。下一轮学习会自动吃进语料池。` })
            } else {
              setMsg({ kind: 'warn', text: `跑完了但没抓到内容（用时 ${secs}s，未计次）。${r.result ? JSON.stringify(r.result).slice(0, 120) : ''}` })
            }
          } else setMsg({ kind: 'err', text: r.error || '抓取失败' })
          await load()
        } catch (e) { setMsg({ kind: 'err', text: '抓取出错：' + e.message }) }
        finally { setRunning(false) }
      }

      if (!st) return null
      const usage = st.usage || {}
      const env = st.env || {}
      const noRoom = (usage.remaining ?? 0) <= 0

      return h('div', { className: 'card' },
        h('div', { className: 'card-title' }, 'B站语料（学说话方式用）',
          h('span', { className: 'hint', style: { marginLeft: 'auto', fontWeight: 400 } },
            `今天 ${usage.used ?? 0}/${usage.limit ?? 3} 次`)),
        h('div', { className: 'hint' },
          '从 B站公开评论区抓语料，学「别人怎么说话」（词汇/梗/句式）。'),
        h('div', { className: 'hint' },
          '**只手动、不定时** —— 自动抓会撞 B站风控。一天最多 3 次。'),
        !env.ok ? h(Notice, { kind: 'warn', title: '抓取依赖未就绪' }, env.reason || '') : null,
        h('div', { className: 'row' },
          h('button', {
            disabled: running || noRoom || !env.ok,
            onClick: go,
          }, running ? '抓取中…（几分钟）' : '现在抓 2 个视频'),
          noRoom ? h('span', { className: 'muted' }, '今天的次数用完了，明天再来') : null,
          !env.ok ? h('span', { className: 'muted' }, '先装 B站工具依赖（见「登录」页环境体检）') : null,
        ),
      )
    }

    // ── 运行页 ──────────────────────────────────────────────────────────────
    /**
     * 日志「贴底才跟随」。
     *
     * 需求：用户在最底部时，新日志来了要保持在最底部；用户往上翻看历史时，
     * 新日志来了**不许**把他弹回底部（那样根本没法读）。
     *
     * 两个容易写错的地方：
     *   ① **判断时机**。必须在内容更新**之前**记住「当时是不是贴底」。
     *      如果等 DOM 更新完再判断，新行一追加 scrollHeight 就变大了，
     *      容器立刻变成「不在底部」——于是永远不跟随，日志看起来是死的。
     *      所以滚动位置用 ref 记，由 scroll 事件维护；内容更新前它已经是上一轮的真相。
     *   ② **程序化滚动也会触发 scroll 事件**。但那正是我们要的（滚到底部后
     *      ref 变回 true），不需要区分「用户滚」和「代码滚」。
     *
     * 阈值 24px 而不是 0：高 DPI / 缩放下列表底部可能差零点几像素，
     * 严判 0 会导致「明明在最底部却不跟随」。24px 小于一行文字高度，不会误判。
     */
    function useStickToBottom (content) {
      const boxRef = useRef(null)
      const stuckRef = useRef(true)
      // stuckRef 给逻辑用（内容更新时读到的是上一轮真相），stuck 给 UI 用（显示「回到底部」）
      const [stuck, setStuck] = useState(true)

      const isAtBottom = (el) => !el || (el.scrollHeight - el.scrollTop - el.clientHeight) <= 24

      const onScroll = useCallback(() => {
        const b = isAtBottom(boxRef.current)
        if (b !== stuckRef.current) {
          stuckRef.current = b
          setStuck(b)
        }
      }, [])

      // useLayoutEffect：在浏览器绘制之前滚，避免「先闪一下旧位置再跳到底部」
      React.useLayoutEffect(() => {
        const el = boxRef.current
        if (!el) return
        if (stuckRef.current) el.scrollTop = el.scrollHeight
      }, [content])

      const jumpToBottom = useCallback(() => {
        const el = boxRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight
        stuckRef.current = true
        setStuck(true)
      }, [])

      return { boxRef, onScroll, stuck, jumpToBottom }
    }

    function RunTab ({ data, busy, run, refresh }) {
      const bridge = data.bridge || {}
      const [log, setLog] = useState(data.bridgeLogTail || '')
      const { boxRef, onScroll, stuck, jumpToBottom } = useStickToBottom(log)

      const loadLog = useCallback(async () => {
        const r = await api('/bridge/log')
        if (r.ok) setLog(r.log || '')
      }, [])

      useEffect(() => {
        if (!bridge.running) return
        const t = setInterval(loadLog, 5000)
        return () => clearInterval(t)
      }, [bridge.running, loadLog])

      const uptime = bridge.running && bridge.uptimeMs
        ? (() => {
            const s = Math.floor(bridge.uptimeMs / 1000)
            const m = Math.floor(s / 60)
            return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
          })()
        : ''

      return h(React.Fragment, null,
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '桥进程',
            bridge.running
              ? h(Badge, { kind: 'ok' }, '运行中')
              : h(Badge, null, '已停止'),
            bridge.running
              ? h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } },
                  `PID ${bridge.pid} · 已运行 ${uptime}`)
              : null),
          h('div', { className: 'hint' },
            '桥是把 QQ 消息接到 DSH 会话上的转发进程。它跑在独立子进程里，崩了不会拖垮 DSH。'),
          bridge.lastError ? h(Notice, { kind: 'err', title: '上次启动失败' }, bridge.lastError) : null,
          h('div', { className: 'row' },
            h('button', {
              className: 'primary',
              disabled: !!busy || bridge.running,
              onClick: () => run('bridge-start', () => post('/bridge/start')),
            }, '启动桥'),
            h('button', {
              disabled: !!busy || !bridge.running,
              onClick: () => run('bridge-stop', () => post('/bridge/stop')),
            }, '停止桥'),
            h('button', {
              disabled: !!busy || !bridge.running,
              onClick: () => run('bridge-restart', async () => {
                await post('/bridge/stop')
                await new Promise(r => setTimeout(r, 800))
                return post('/bridge/start')
              }),
            }, '重启桥'),
            h('button', { className: 'tiny', onClick: refresh }, '刷新状态'),
          ),
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '桥日志',
            h('span', { className: 'muted', style: { fontWeight: 400 } }, '最后 100 行'),
            h('button', { className: 'tiny', onClick: loadLog, style: { marginLeft: 'auto' } }, '刷新')),
          h('div', {
            className: 'logbox',
            ref: boxRef,
            onScroll,
            style: { maxHeight: 420 },
          }, log || '（暂无日志）'),
          // 只有用户往上翻、脱离了底部才出现；贴底时它没用处，不该占地方
          !stuck && log
            ? h('div', { className: 'row' },
                h('span', { className: 'muted' }, '已暂停跟随（你在看历史）'),
                h('button', { className: 'tiny', onClick: jumpToBottom }, '回到底部'))
            : null,
          h('div', { className: 'muted mono' },
            `完整日志 ${data.env?.dataDir}/logs/bridge.out`),
        ),
      )
    }

    // ── 高级页 ──────────────────────────────────────────────────────────────
    function AdvancedTab ({ data, cfg, saveConfig, run, setMsg }) {
      const [raw, setRaw] = useState(cfg.advanced?.rawJson || '')
      const [err, setErr] = useState('')

      const save = () => {
        if (raw.trim()) {
          try { JSON.parse(raw) } catch (e) { setErr('不是合法 JSON：' + e.message); return }
        }
        setErr('')
        saveConfig({ advanced: { rawJson: raw } })
      }

      return h(React.Fragment, null,
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '总开关'),
          h(SwitchRow, {
            label: '启用（DSH 启动时自动起桥）',
            desc: '关掉后插件只提供设置界面，不会自动连 QQ',
            on: cfg.enabled === true,
            onChange: v => saveConfig({ enabled: v }),
          }),
        ),

        // 运行时（dsh 可执行文件 + profile）—— 桥靠这个启动 LLM
        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, 'LLM 运行时'),
          h('div', { className: 'hint' },
            '桥用一个独立的 dsh 进程当大脑，这里配它怎么启动。留空 = 自动探测。'),

          h(Field, {
            label: 'dsh 可执行文件',
            sub: '留空自动找 dsh。Windows 上要填 .cmd 的完整路径，例如 D:/DSH/resources/runtime/cli/bin/dsh.cmd',
          },
            h(TextInput, {
              value: cfg.dsh?.bin || '',
              onCommit: v => saveConfig({ dsh: { bin: v } }),
              placeholder: '（留空 = 自动探测）',
            })),

          h(Field, {
            label: 'profile 名',
            sub: '留空 = 自动：反推宿主 profile；但 desktop 是 Electron 独占、CLI 会直接拒绝，所以会自动落到随附的 acp',
          },
            h(TextInput, {
              value: cfg.dsh?.profile || '',
              onCommit: v => saveConfig({ dsh: { profile: v } }),
              placeholder: '留空（自动 → acp）',
            })),

          h(Notice, { title: '桥日志里出现这些错误？' },
            h('ul', { style: { marginTop: 6 } },
              h('li', null,
                h('code', null, 'spawn dsh ENOENT'),
                ' —— 找不到 dsh。Windows 上 Node 不会自动补 .cmd，把上面「dsh 可执行文件」填成完整路径'),
              h('li', null,
                h('code', null, 'initialize 超时'),
                ' —— dsh 起了但没响应。多半是 profile 名不对，或那个 profile 的模型通道有问题'),
              h('li', null,
                h('code', null, 'profile "desktop" is managed exclusively by the Electron application'),
                ' —— desktop 只能由桌面版自己起。把 profile 留空（会自动用 acp）'),
            ),
          ),
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '数据目录'),
          h('div', { className: 'mono', style: { color: 'var(--qq-2)', wordBreak: 'break-all' } },
            data?.env?.dataDir || '（未取到）'),
          h('div', { className: 'muted' },
            'config.json · secrets.json · 人格 agent/persona/ · 记忆 agent/memory/ · 日志 logs/'),
        ),

        h('div', { className: 'card' },
          h('div', { className: 'card-title' }, '原始配置覆盖',
            h('span', { className: 'muted', style: { marginLeft: 'auto', fontWeight: 400 } }, '进阶')),
          h('div', { className: 'hint' },
            '写一段 JSON，会深合并覆盖上面所有页面设置。用来改界面没覆盖到的字段（比如实验性开关）；不确定就别动。'),
          h('textarea', {
            value: raw,
            onChange: e => setRaw(e.target.value),
            placeholder: '{\n  "policy": { "readAllGroupMessages": true }\n}',
            style: { minHeight: 160, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12 },
          }),
          err ? h(Notice, { kind: 'err' }, err) : null,
          h('div', { className: 'row', style: { marginTop: 10 } },
            h('button', { className: 'primary', onClick: save }, '保存覆盖'),
            h('button', {
              className: 'danger',
              onClick: () => run('reset', async () => {
                const r = await post('/config/reset')
                if (r.ok) { setRaw(''); setMsg({ kind: 'ok', text: '已恢复默认（凭据没动）' }) }
                return r
              }),
            }, '恢复全部默认设置'),
          ),
          h('div', { className: 'hint', style: { marginTop: 8 } },
            '「恢复默认」不会清掉凭据（QQ 号 / token 在 secrets.json 里，单独存）。'),
        ),
      )
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    const inject = ['slots']

    function apply (ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'llminqq', order: 24, label: 'QQ 通道' },
        () => React.createElement(QQPanel, { ctx }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
