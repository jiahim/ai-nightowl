export interface WebAsset {
  contentType: string;
  cacheControl: string;
  body: string;
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a1020">
  <title>ai-nightowl Console</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div class="aurora aurora-a"></div><div class="aurora aurora-b"></div>
  <header class="topbar">
    <a class="brand" href="/" aria-label="ai-nightowl 首页">
      <span class="brand-mark" aria-hidden="true">◒</span>
      <span><b>ai-nightowl</b><small>Local Control Plane</small></span>
    </a>
    <div class="top-actions">
      <span id="connection" class="pill"><i></i>正在连接</span>
      <button id="provider-settings" class="button small secondary" type="button" aria-label="打开模型设置">
        <span id="provider-settings-dot" class="settings-dot" aria-hidden="true"></span>
        <span id="provider-settings-label">模型设置</span>
      </button>
      <button id="refresh" class="icon-button" title="刷新" aria-label="刷新">↻</button>
    </div>
  </header>

  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">今晚的工作，清晨可追溯</p>
        <h1 id="hero-title">还没有蓝图</h1>
        <p id="hero-subtitle" class="hero-copy">导入一个目标，夜猫子会按里程碑可靠推进。</p>
      </div>
      <div class="hero-actions">
        <button id="new-blueprint" class="button secondary">导入蓝图</button>
        <button id="tick" class="button secondary">推进一步</button>
        <button id="run" class="button primary">连续运行</button>
        <button id="stop" class="button danger" hidden>停止</button>
      </div>
    </section>

    <section class="metrics" aria-label="运行概览">
      <article class="metric progress-metric">
        <div id="progress-ring" class="progress-ring"><span id="progress-value">0%</span></div>
        <div><span>子任务进度</span><strong id="progress-copy">0 / 0</strong></div>
      </article>
      <article class="metric"><span>运行状态</span><strong id="runtime-phase">空闲</strong><small id="runtime-copy">等待任务</small></article>
      <article class="metric"><span>待处理阻塞</span><strong id="blocked-count">0</strong><small>需要重试或人工确认</small></article>
      <article class="metric"><span>累计实付</span><strong id="cost-value">¥0.000</strong><small id="cost-copy">尚无模型调用</small></article>
    </section>

    <div class="layout">
      <section class="panel main-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Blueprint</p><h2>里程碑与任务</h2></div>
          <span id="updated-at" class="muted">—</span>
        </div>
        <div id="empty-state" class="empty-state">
          <div class="empty-orbit">✦</div>
          <h3>从一份可验收的蓝图开始</h3>
          <p>定义目标、里程碑、依赖与完成标准，然后交给后台运行。</p>
          <button class="button primary" data-action="open-blueprint">导入第一份蓝图</button>
        </div>
        <div id="milestones" class="milestones" hidden></div>
      </section>

      <aside class="side-stack">
        <section class="panel runtime-panel">
          <div class="panel-heading"><div><p class="eyebrow">Runtime</p><h2>本轮活动</h2></div></div>
          <div id="runtime-detail" class="runtime-detail"><p class="muted">还没有后台运行记录。</p></div>
        </section>
        <section class="panel plugin-panel">
          <div class="panel-heading"><div><p class="eyebrow">Capabilities</p><h2>插件与 Provider</h2></div><button id="provider-settings-card" class="button small secondary" type="button">配置模型</button></div>
          <div id="plugins" class="plugin-list"><p class="muted">正在读取插件目录…</p></div>
        </section>
      </aside>
    </div>
  </main>

  <dialog id="blueprint-dialog">
    <form id="blueprint-form" method="dialog">
      <div class="dialog-heading"><div><p class="eyebrow">Create</p><h2>导入 Blueprint JSON</h2></div><button class="icon-button" value="cancel" aria-label="关闭">×</button></div>
      <p class="muted">提交会替换当前单运行状态。多 Run 历史将在下一阶段提供。</p>
      <label for="blueprint-json">蓝图内容</label>
      <textarea id="blueprint-json" spellcheck="false" required></textarea>
      <p id="blueprint-error" class="form-error" role="alert"></p>
      <div class="dialog-actions"><button value="cancel" class="button secondary">取消</button><button id="submit-blueprint" value="default" class="button primary">校验并导入</button></div>
    </form>
  </dialog>

  <dialog id="provider-dialog" class="provider-dialog">
    <form id="provider-form">
      <div class="dialog-heading">
        <div>
          <p class="eyebrow">Local Provider Setup</p>
          <h2>模型与 API Key</h2>
          <p class="muted provider-dialog-copy">配置只保存在这台电脑，由本地 Node 服务读取。已保存的密钥永不回显到网页。</p>
        </div>
        <button id="close-provider-settings" class="icon-button" type="button" aria-label="关闭">×</button>
      </div>

      <div class="security-note">
        <span aria-hidden="true">⌾</span>
        <div><b>本地私有存储</b><p>密钥文件权限为 0600；浏览器只会收到“是否已配置”和配置来源。</p></div>
      </div>

      <section class="provider-advisor">
        <div class="provider-section-head">
          <div><p class="eyebrow">Smart Match</p><h3>让 AI 帮你匹配</h3></div>
          <span class="preview-tag">价格与额度由规则复核</span>
        </div>
        <p class="muted">描述任务规模、是否着急、预算或可等待时间。AI 只理解意图，系统再按已确认的价格、工作日历和周期额度计算候选，不会让模型猜价格。</p>
        <div class="advisor-composer">
          <textarea id="provider-request" rows="2" placeholder="例如：复杂代码审查，约 8 万 tokens，不着急，可以等 6 小时，优先省钱"></textarea>
          <button id="analyze-provider" class="button primary" type="button">分析并给出选择</button>
        </div>
        <div id="provider-recommendation" class="provider-recommendation" hidden></div>
      </section>

      <div class="provider-routing-grid">
        <div class="preferred-provider field">
          <label for="preferred-provider">首选平台 <span>自动会按当前规则动态选择</span></label>
          <select id="preferred-provider">
            <option value="auto">自动选择（推荐）</option>
            <option value="deepseek">DeepSeek 优先</option>
            <option value="zhipu">智谱 GLM 优先</option>
          </select>
        </div>
        <div class="preferred-provider field">
          <label for="provider-priority">自动选择偏好 <span>随下一次调用立即生效</span></label>
          <select id="provider-priority">
            <option value="balanced">成本与质量平衡</option>
            <option value="cost">最低预计成本</option>
            <option value="speed">立即可用优先</option>
            <option value="quality">推理质量优先</option>
          </select>
        </div>
      </div>

      <div class="provider-config-grid">
        <section class="provider-config-card">
          <div class="provider-config-head">
            <span class="provider-logo deepseek-logo" aria-hidden="true">D</span>
            <div><h3>DeepSeek</h3><small>DEEPSEEK_API_KEY</small></div>
            <span id="deepseek-status" class="provider-status">读取中</span>
          </div>
          <label class="key-label" for="deepseek-key">新 API Key</label>
          <input id="deepseek-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入后保存；留空保持不变">
          <div class="provider-key-footer">
            <small id="deepseek-source">尚未配置</small>
            <button id="clear-deepseek-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="deepseek-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>

        <section class="provider-config-card">
          <div class="provider-config-head">
            <span class="provider-logo zhipu-logo" aria-hidden="true">GLM</span>
            <div><h3>智谱 GLM</h3><small>ZHIPU_API_KEY</small></div>
            <span id="zhipu-status" class="provider-status">读取中</span>
          </div>
          <label class="key-label" for="zhipu-key">新 API Key</label>
          <input id="zhipu-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入后保存；留空保持不变">
          <div class="provider-key-footer">
            <small id="zhipu-source">尚未配置</small>
            <button id="clear-zhipu-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="zhipu-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>

        <section class="provider-config-card">
          <div class="provider-config-head">
            <span class="provider-logo minimax-logo" aria-hidden="true">M</span>
            <div><h3>MiniMax 按量</h3><small>MINIMAX_API_KEY</small></div>
            <span id="minimax-status" class="provider-status">读取中</span>
          </div>
          <label class="key-label" for="minimax-key">普通按量 API Key</label>
          <input id="minimax-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入后保存；留空保持不变">
          <div class="provider-key-footer">
            <small id="minimax-source">尚未配置</small>
            <button id="clear-minimax-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="minimax-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>

        <section class="provider-config-card">
          <div class="provider-config-head">
            <span class="provider-logo minimax-plan-logo" aria-hidden="true">PLAN</span>
            <div><h3>MiniMax Plan</h3><small>MINIMAX_PLAN_API_KEY</small></div>
            <span id="minimax-plan-status" class="provider-status">读取中</span>
          </div>
          <label class="key-label" for="minimax-plan-key">Token Plan 专属 Key</label>
          <input id="minimax-plan-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="与普通按量 Key 分开保存">
          <div class="provider-key-footer">
            <small id="minimax-plan-source">尚未配置</small>
            <button id="clear-minimax-plan-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="minimax-plan-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>

        <section class="provider-config-card">
          <div class="provider-config-head">
            <span class="provider-logo openai-logo" aria-hidden="true">OA</span>
            <div><h3>OpenAI</h3><small>OPENAI_API_KEY</small></div>
            <span id="openai-status" class="provider-status">读取中</span>
          </div>
          <label class="key-label" for="openai-key">OpenAI API Key</label>
          <input id="openai-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入后保存；留空保持不变">
          <div class="provider-key-footer">
            <small id="openai-source">尚未配置</small>
            <button id="clear-openai-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="openai-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>

        <section class="provider-config-card custom-provider-card">
          <div class="provider-config-head">
            <span class="provider-logo custom-openai-logo" aria-hidden="true">API</span>
            <div><h3 id="openai-compatible-name-heading">自定义 OpenAI 兼容</h3><small>OPENAI_COMPATIBLE_API_KEY</small></div>
            <span id="openai-compatible-status" class="provider-status">读取中</span>
          </div>
          <div class="custom-provider-toggle">
            <label><input id="custom-openai-enabled" type="checkbox"> 启用这个自定义接口</label>
            <label><input id="custom-openai-api-key-required" type="checkbox" checked> 接口需要 API Key</label>
          </div>
          <div class="custom-provider-fields">
            <div class="field"><label for="custom-openai-name">显示名称</label><input id="custom-openai-name" value="自定义 OpenAI 兼容" maxlength="80"></div>
            <div class="field wide"><label for="custom-openai-base-url">Base URL <span>填写到 /v1</span></label><input id="custom-openai-base-url" type="url" spellcheck="false" placeholder="https://example.com/v1"></div>
            <div class="field"><label for="custom-openai-chat-models">普通模型 ID <span>逗号分隔</span></label><input id="custom-openai-chat-models" spellcheck="false" placeholder="my-chat-model"></div>
            <div class="field"><label for="custom-openai-reasoner-models">推理模型 ID <span>可选</span></label><input id="custom-openai-reasoner-models" spellcheck="false" placeholder="my-reasoner-model"></div>
            <div class="field"><label for="custom-openai-input-price">输入价 <span>元/百万 tokens</span></label><input id="custom-openai-input-price" type="number" min="0" step="any" placeholder="0"></div>
            <div class="field"><label for="custom-openai-output-price">输出价 <span>元/百万 tokens</span></label><input id="custom-openai-output-price" type="number" min="0" step="any" placeholder="0"></div>
            <div class="field"><label for="custom-openai-cache-price">缓存命中价 <span>可选</span></label><input id="custom-openai-cache-price" type="number" min="0" step="any"></div>
            <div class="field"><label for="custom-openai-context-window">上下文窗口 <span>tokens</span></label><input id="custom-openai-context-window" type="number" min="1" step="1" value="128000"></div>
          </div>
          <label class="key-label" for="openai-compatible-key">API Key（无需密钥时留空）</label>
          <input id="openai-compatible-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入后保存；留空保持不变">
          <div class="provider-key-footer">
            <small id="openai-compatible-source">尚未配置</small>
            <button id="clear-openai-compatible-key" class="button small ghost" type="button" hidden>删除本地密钥</button>
          </div>
          <p id="openai-compatible-policy-summary" class="policy-summary">正在读取资费画像…</p>
        </section>
      </div>

      <details class="provider-policy-editor">
        <summary>资费、工作日与周期额度配置</summary>
        <p class="muted">平台目录会自动提供默认价格。只有套餐与目录不同，或存在周/月额度、周末价、节假日价时才需要覆盖。</p>
        <div class="policy-toolbar">
          <div class="field"><label for="policy-provider">配置平台</label><select id="policy-provider"></select></div>
          <div class="field"><label for="policy-timezone">计费时区</label><input id="policy-timezone" value="Asia/Shanghai" placeholder="Asia/Shanghai"></div>
        </div>
        <div class="policy-common-grid">
          <div class="field"><label for="policy-working-multiplier">工作日倍率 <span>1=原价</span></label><input id="policy-working-multiplier" type="number" min="0" step="0.01" placeholder="留空表示不覆盖"></div>
          <div class="field"><label for="policy-nonworking-multiplier">非工作日倍率 <span>周末/节假日</span></label><input id="policy-nonworking-multiplier" type="number" min="0" step="0.01" placeholder="留空表示不覆盖"></div>
          <div class="field"><label for="policy-window-start">优惠开始</label><input id="policy-window-start" type="time"></div>
          <div class="field"><label for="policy-window-end">优惠结束</label><input id="policy-window-end" type="time"></div>
          <div class="field"><label for="policy-window-multiplier">优惠倍率</label><input id="policy-window-multiplier" type="number" min="0" step="0.01" placeholder="例如 0.5"></div>
          <div class="field"><label for="policy-quota-period">额度周期</label><select id="policy-quota-period"><option value="">无周期额度</option><option value="rolling">滚动窗口</option><option value="day">每日</option><option value="week">每周</option><option value="month">每月</option></select></div>
          <div class="field"><label for="policy-quota-window">滚动窗口 <span>分钟</span></label><input id="policy-quota-window" type="number" min="1" step="1" placeholder="例如 300"></div>
          <div class="field"><label for="policy-quota-unit">额度单位</label><select id="policy-quota-unit"><option value="tokens">tokens</option><option value="requests">调用次数</option><option value="cost">人民币成本</option></select></div>
          <div class="field"><label for="policy-quota-limit">额度上限</label><input id="policy-quota-limit" type="number" min="0" step="any" placeholder="例如 1000000"></div>
          <div class="field"><label for="policy-nonworking-dates">额外非工作日 <span>逗号分隔</span></label><input id="policy-nonworking-dates" placeholder="2026-10-01, 2026-10-02"></div>
          <div class="field"><label for="policy-working-dates">调休工作日 <span>逗号分隔</span></label><input id="policy-working-dates" placeholder="2026-10-10"></div>
        </div>
        <div class="policy-actions">
          <button id="restore-provider-policy" class="button ghost" type="button">恢复平台自报</button>
          <button id="save-common-policy" class="button secondary" type="button">保存常用规则</button>
        </div>
        <details class="policy-json-editor">
          <summary>高级：编辑完整规则 JSON</summary>
          <p class="muted">用于多个时段、不同模型绝对价格或多重日/周/月额度。保存前服务端会完整校验。</p>
          <textarea id="policy-json" spellcheck="false"></textarea>
          <div class="policy-actions"><button id="save-policy-json" class="button secondary" type="button">校验并保存 JSON</button></div>
        </details>
      </details>

      <p id="provider-error" class="form-error" role="alert"></p>
      <div class="dialog-actions provider-dialog-actions">
        <span class="muted">保存后，下一次模型调用立即生效，无需重启。</span>
        <div><button id="cancel-provider-settings" class="button secondary" type="button">取消</button><button id="save-provider-settings" class="button primary" type="submit">保存设置</button></div>
      </div>
    </form>
  </dialog>


  <dialog id="detail-dialog">
    <div class="dialog-heading"><div><p class="eyebrow">Evidence</p><h2 id="detail-title">任务详情</h2></div><button id="close-detail" class="icon-button" aria-label="关闭">×</button></div>
    <div id="detail-content" class="detail-content"></div>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script src="/app.js" defer></script>
</body>
</html>`;

const CSS = `
:root{color-scheme:dark;--bg:#080d18;--panel:rgba(17,25,43,.82);--panel-2:#131d31;--line:rgba(148,163,184,.16);--text:#eef4ff;--muted:#91a0b8;--cyan:#67e8f9;--blue:#7aa2ff;--violet:#a78bfa;--green:#66e3a4;--amber:#f8cf72;--red:#fb7185;--shadow:0 24px 70px rgba(0,0,0,.34);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#16264c 0,var(--bg) 38%);color:var(--text);overflow-x:hidden}.aurora{position:fixed;width:38rem;height:38rem;border-radius:50%;filter:blur(110px);opacity:.1;pointer-events:none}.aurora-a{background:#4f46e5;top:-18rem;left:-10rem}.aurora-b{background:#0891b2;right:-18rem;top:20rem}.topbar{height:76px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,4vw,64px);border-bottom:1px solid var(--line);background:rgba(8,13,24,.68);backdrop-filter:blur(20px);position:sticky;top:0;z-index:20}.brand{display:flex;gap:12px;align-items:center;color:inherit;text-decoration:none}.brand-mark{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#0891b2);font-size:25px;box-shadow:0 0 25px rgba(103,232,249,.2)}.brand b{display:block;letter-spacing:.01em}.brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px;letter-spacing:.08em;text-transform:uppercase}.top-actions,.hero-actions,.dialog-actions{display:flex;align-items:center;gap:10px}.pill{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px}.pill i{width:7px;height:7px;background:var(--amber);border-radius:50%;box-shadow:0 0 10px currentColor}.pill.online i{background:var(--green)}.pill.offline i{background:var(--red)}button{font:inherit}.icon-button{width:38px;height:38px;border:1px solid var(--line);background:rgba(255,255,255,.035);color:var(--text);border-radius:11px;cursor:pointer;font-size:20px}.icon-button:hover,.button:hover{transform:translateY(-1px);border-color:rgba(103,232,249,.5)}main{width:min(1440px,calc(100% - 40px));margin:0 auto;padding:46px 0 70px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;margin-bottom:34px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;color:var(--cyan);font-weight:700;margin:0 0 9px}.hero h1{font-size:clamp(32px,5vw,58px);line-height:1.03;letter-spacing:-.045em;margin:0;max-width:850px}.hero-copy{color:var(--muted);font-size:16px;margin:16px 0 0;max-width:700px}.button{border:1px solid var(--line);border-radius:12px;padding:11px 15px;color:var(--text);cursor:pointer;transition:.16s ease;white-space:nowrap}.button:disabled{opacity:.45;cursor:not-allowed;transform:none}.button.primary{background:linear-gradient(135deg,#5b5ce2,#0788a4);border-color:transparent;box-shadow:0 8px 25px rgba(67,97,238,.24)}.button.secondary{background:rgba(255,255,255,.045)}.button.danger{background:rgba(251,113,133,.1);color:#fecdd3;border-color:rgba(251,113,133,.28)}.button.small{padding:7px 10px;border-radius:9px;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric,.panel{background:linear-gradient(145deg,rgba(19,29,49,.88),rgba(12,19,34,.86));border:1px solid var(--line);box-shadow:var(--shadow);backdrop-filter:blur(16px)}.metric{min-height:124px;border-radius:18px;padding:21px;display:flex;flex-direction:column;justify-content:center}.metric span{font-size:12px;color:var(--muted);letter-spacing:.04em}.metric strong{font-size:27px;margin-top:9px;letter-spacing:-.03em}.metric small{color:var(--muted);margin-top:6px}.progress-metric{flex-direction:row;align-items:center;justify-content:flex-start;gap:17px}.progress-metric div:last-child{display:flex;flex-direction:column}.progress-ring{--progress:0deg;width:72px;height:72px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--cyan) var(--progress),rgba(255,255,255,.075) 0);position:relative}.progress-ring:before{content:"";position:absolute;inset:7px;border-radius:50%;background:#111a2b}.progress-ring span{position:relative;color:var(--text);font-size:15px;font-weight:800}.layout{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(310px,.75fr);gap:18px}.panel{border-radius:20px;padding:23px}.panel-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}.panel-heading h2{font-size:18px;margin:0;letter-spacing:-.015em}.muted{color:var(--muted);font-size:13px}.empty-state{text-align:center;padding:70px 20px 80px}.empty-state h3{font-size:22px;margin:18px 0 8px}.empty-state p{color:var(--muted);margin:0 auto 24px;max-width:440px}.empty-orbit{width:68px;height:68px;border:1px solid rgba(103,232,249,.3);background:rgba(103,232,249,.06);border-radius:50%;display:grid;place-items:center;margin:auto;color:var(--cyan);font-size:24px;box-shadow:0 0 35px rgba(103,232,249,.12)}.milestones{display:flex;flex-direction:column;gap:14px}.milestone{border:1px solid var(--line);background:rgba(4,9,19,.25);border-radius:16px;overflow:hidden}.milestone-head{display:grid;grid-template-columns:38px 1fr auto;gap:12px;align-items:center;padding:16px}.status-icon{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:rgba(148,163,184,.09);color:var(--muted)}.status-icon.done{color:var(--green);background:rgba(102,227,164,.1)}.status-icon.blocked{color:var(--red);background:rgba(251,113,133,.1)}.status-icon.in-progress{color:var(--cyan);background:rgba(103,232,249,.1)}.milestone-title{font-weight:750}.milestone-goal{color:var(--muted);font-size:13px;margin-top:3px}.task-list{border-top:1px solid var(--line)}.task{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:11px;padding:13px 16px;border-bottom:1px solid rgba(148,163,184,.09);align-items:start}.task:last-child{border-bottom:0}.task-dot{width:9px;height:9px;border-radius:50%;margin-top:5px;background:#58657b;box-shadow:0 0 0 4px rgba(88,101,123,.12)}.task-dot.done{background:var(--green)}.task-dot.blocked{background:var(--red)}.task-dot.in-progress{background:var(--cyan);animation:pulse 1.4s infinite}.task-name{font-size:14px;font-weight:650}.task-meta,.task-evidence{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45}.task-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.side-stack{display:flex;flex-direction:column;gap:18px}.runtime-detail{display:grid;gap:12px}.runtime-line{display:flex;justify-content:space-between;gap:15px;font-size:13px;padding-bottom:10px;border-bottom:1px solid rgba(148,163,184,.1)}.runtime-line span:first-child{color:var(--muted)}.runtime-reports{display:flex;flex-direction:column;gap:8px;margin-top:4px}.report{font-size:12px;color:var(--muted);padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.03)}.plugin-list{display:flex;flex-direction:column;gap:10px}.plugin{padding:12px;border:1px solid rgba(148,163,184,.12);border-radius:13px;background:rgba(255,255,255,.025)}.plugin-top{display:flex;justify-content:space-between;gap:10px}.plugin b{font-size:13px}.plugin small{color:var(--muted)}.plugin-models{color:var(--muted);font-size:11px;margin-top:5px;line-height:1.4}.preview-tag{font-size:10px;padding:5px 8px;color:var(--amber);border:1px solid rgba(248,207,114,.25);border-radius:99px}.badge{font-size:10px;padding:4px 7px;border-radius:99px;background:rgba(103,232,249,.09);color:var(--cyan)}dialog{width:min(720px,calc(100% - 28px));border:1px solid var(--line);border-radius:20px;background:#10192b;color:var(--text);padding:23px;box-shadow:0 35px 100px rgba(0,0,0,.65)}dialog::backdrop{background:rgba(2,6,14,.76);backdrop-filter:blur(8px)}.dialog-heading{display:flex;justify-content:space-between;align-items:flex-start}.dialog-heading h2{margin:0;font-size:21px}label{display:block;font-size:12px;color:var(--muted);margin:20px 0 8px}textarea{width:100%;min-height:360px;resize:vertical;border:1px solid var(--line);border-radius:13px;background:#080f1d;color:#dbeafe;padding:14px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}textarea:focus{border-color:rgba(103,232,249,.55);box-shadow:0 0 0 3px rgba(103,232,249,.08)}.dialog-actions{justify-content:flex-end;margin-top:16px}.form-error{min-height:18px;color:#fda4af;font-size:12px}.detail-content{max-height:65vh;overflow:auto}.evidence{padding:12px 0;border-bottom:1px solid var(--line)}.evidence pre{white-space:pre-wrap;word-break:break-word;color:#cbd5e1;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#080f1d;padding:12px;border-radius:10px}.toast{position:fixed;right:24px;bottom:24px;max-width:400px;padding:13px 16px;border-radius:12px;background:#17233a;border:1px solid var(--line);box-shadow:var(--shadow);opacity:0;transform:translateY(10px);pointer-events:none;transition:.2s;z-index:40}.toast.show{opacity:1;transform:none}.toast.error{border-color:rgba(251,113,133,.4);color:#fecdd3}@keyframes pulse{50%{box-shadow:0 0 0 7px rgba(103,232,249,0)}}@media(max-width:1000px){.metrics{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}.side-stack{display:grid;grid-template-columns:repeat(2,1fr)}}@media(max-width:720px){.topbar{padding:0 18px}.pill{display:none}main{width:min(100% - 24px,1440px);padding-top:28px}.hero{align-items:flex-start;flex-direction:column}.hero-actions{width:100%;flex-wrap:wrap}.hero-actions .button{flex:1}.metrics{grid-template-columns:1fr}.metric{min-height:104px}.layout{display:block}.side-stack{display:flex;margin-top:16px}.panel{padding:17px}.task{grid-template-columns:18px 1fr}.task-actions{grid-column:2;justify-content:flex-start}.milestone-head{grid-template-columns:34px 1fr}.milestone-head>.badge{grid-column:2;justify-self:start}.brand small{display:none}}
`;

const PROVIDER_CSS = `
.settings-dot{width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 10px rgba(248,207,114,.45)}
.settings-dot.ready{background:var(--green);box-shadow:0 0 10px rgba(102,227,164,.48)}
.plugin-provider-meta{display:flex;align-items:center;gap:8px}.provider-state{display:inline-flex;align-items:center;gap:5px}.provider-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--amber)}.provider-state.configured{color:var(--green)}.provider-state.configured::before{background:var(--green)}
.button.ghost{background:transparent;color:var(--muted);border-color:transparent;box-shadow:none}
.button.ghost:hover{color:var(--text);background:rgba(255,255,255,.045);border-color:var(--line)}
.provider-dialog{width:min(980px,calc(100% - 28px));max-height:min(94vh,940px);overflow:auto}
.provider-dialog-copy{max-width:610px;margin:8px 0 0;line-height:1.55}
.provider-dialog input,.provider-dialog select,.provider-dialog textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:#080f1d;color:var(--text);padding:11px 12px;font:inherit;line-height:1.45;outline:none}
.provider-dialog input:focus,.provider-dialog select:focus,.provider-dialog textarea:focus{border-color:rgba(103,232,249,.55);box-shadow:0 0 0 3px rgba(103,232,249,.08)}
.provider-dialog textarea{min-height:70px}
.security-note{display:flex;align-items:flex-start;gap:11px;margin:20px 0 18px;padding:12px 13px;border:1px solid rgba(102,227,164,.24);border-radius:13px;background:rgba(102,227,164,.07)}
.security-note>span{width:28px;height:28px;flex:0 0 auto;display:grid;place-items:center;border-radius:9px;background:rgba(102,227,164,.13);color:var(--green)}
.security-note b{font-size:12px}.security-note p{margin:3px 0 0;color:var(--muted);font-size:11px;line-height:1.5}
.provider-advisor{margin:0 0 18px;padding:16px;border:1px solid rgba(103,232,249,.24);border-radius:16px;background:linear-gradient(135deg,rgba(103,232,249,.07),rgba(167,139,250,.06))}
.provider-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.provider-section-head h3{margin:2px 0 0;font-size:15px}
.provider-advisor>p{margin:9px 0 12px;line-height:1.55}.advisor-composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:stretch}.advisor-composer textarea{min-height:62px}.advisor-composer .button{align-self:stretch}
.provider-recommendation{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.recommendation-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}.recommendation-head b{font-size:12px;line-height:1.5}.recommendation-head small{color:var(--muted);font-size:9px;white-space:nowrap}
.recommendation-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.recommendation-card{padding:12px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.025)}.recommendation-card.recommended{border-color:rgba(102,227,164,.4)}.recommendation-card.unavailable{opacity:.68}.recommendation-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.recommendation-title b{font-size:12px}.recommendation-title span{color:var(--cyan);font-size:10px}.recommendation-card p{margin:7px 0;color:var(--muted);font-size:10px;line-height:1.5}.recommendation-tags{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0 10px}.recommendation-tags span{padding:3px 6px;border-radius:99px;background:rgba(255,255,255,.045);color:var(--muted);font-size:8px}.recommendation-warning{color:var(--amber)!important}
.provider-routing-grid,.policy-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}.provider-config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.provider-config-card{min-width:0;padding:15px;border:1px solid var(--line);border-radius:15px;background:rgba(255,255,255,.025)}
.provider-config-head{display:grid;grid-template-columns:38px 1fr auto;gap:10px;align-items:center;margin-bottom:15px}.provider-logo{width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(103,232,249,.24);border-radius:12px;background:rgba(103,232,249,.09);color:var(--cyan);font-size:15px;font-weight:850}.zhipu-logo{color:var(--violet);font-size:10px}.minimax-logo,.minimax-plan-logo{color:var(--amber)}.minimax-plan-logo{font-size:7px}.openai-logo{color:var(--green);font-size:10px}.custom-openai-logo{font-size:9px}.provider-config-head h3{margin:0;font-size:14px}.provider-config-head small{display:block;margin-top:3px;color:var(--muted);font:9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}
.provider-status{padding:4px 7px;border:1px solid rgba(248,207,114,.25);border-radius:99px;background:rgba(248,207,114,.07);color:var(--amber);font-size:9px;white-space:nowrap}.provider-status.configured{border-color:rgba(102,227,164,.28);background:rgba(102,227,164,.08);color:var(--green)}
.field{min-width:0}.field label,.key-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 7px;color:#dbeafe;font-size:11px;font-weight:700}.field label span{color:var(--muted);font-size:10px;font-weight:500}.custom-provider-card{grid-column:1/-1}.custom-provider-toggle{display:flex;flex-wrap:wrap;gap:10px 18px;margin:-2px 0 13px}.custom-provider-toggle label{display:inline-flex;align-items:center;gap:7px;margin:0;color:#dbeafe;font-size:10px;cursor:pointer}.custom-provider-toggle input{width:14px;height:14px;margin:0;accent-color:var(--cyan)}.custom-provider-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:13px}.custom-provider-fields .wide{grid-column:1/-1}
.provider-key-footer{min-height:30px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.provider-key-footer small{color:var(--muted);font-size:10px;line-height:1.4}.policy-summary{margin:9px 0 0;padding-top:9px;border-top:1px solid var(--line);color:var(--muted);font-size:9px;line-height:1.5}
.provider-policy-editor{margin:14px 0;padding:14px 15px;border:1px solid var(--line);border-radius:15px;background:rgba(255,255,255,.025)}.provider-policy-editor>summary,.policy-json-editor>summary{font-size:12px;font-weight:750;cursor:pointer}.provider-policy-editor>p,.policy-json-editor>p{margin:10px 0 13px;line-height:1.5}.policy-toolbar{margin-top:14px}.policy-common-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}.policy-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.policy-json-editor{margin-top:13px;padding-top:12px;border-top:1px solid var(--line)}#policy-json{min-height:240px;margin-top:10px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.provider-dialog-actions{justify-content:space-between;padding-top:14px;border-top:1px solid var(--line)}.provider-dialog-actions>div{display:flex;align-items:center;gap:9px}
@media(max-width:720px){.provider-dialog{width:min(100% - 12px,800px);max-height:96vh;padding:18px}.provider-config-grid,.provider-routing-grid,.policy-toolbar,.policy-common-grid,.recommendation-grid,.custom-provider-fields{grid-template-columns:1fr}.custom-provider-fields .wide{grid-column:auto}.advisor-composer{grid-template-columns:1fr}.provider-dialog-actions{align-items:stretch;flex-direction:column}.provider-dialog-actions>div{display:grid;grid-template-columns:.8fr 1.2fr}.provider-dialog-actions .button{width:100%}}
`;

function clientApp(): void {
  type Json = Record<string, any>;
  const managedProviderIds = [
    'deepseek', 'zhipu', 'minimax', 'minimax-plan', 'openai', 'openai-compatible',
  ] as const;
  type ManagedProviderId = typeof managedProviderIds[number];
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const app: {
    status: Json | null;
    runtime: Json | null;
    providerSettings: Json | null;
    providerRecommendation: Json | null;
    timer: number | null;
    busy: boolean;
  } = {
    status: null,
    runtime: null,
    providerSettings: null,
    providerRecommendation: null,
    timer: null,
    busy: false,
  };
  const phases: Record<string, string> = {
    idle: '空闲', running: '运行中', stopping: '正在停止', succeeded: '已完成',
    blocked: '已阻塞', cancelled: '已停止', 'limit-reached': '达到轮数上限', failed: '运行失败',
  };
  const blueprintTemplate = {
    id: 'my-night-plan',
    title: '今晚完成一个可验收目标',
    description: '描述最终希望获得的结果。',
    constraints: ['只使用已授权的能力'],
    definitionOfDone: '所有里程碑通过验收，并给出可查看的结果。',
    milestones: [{
      id: 'm1', name: '第一阶段', goal: '完成第一阶段目标', acceptance: [],
      subtasks: [{
        id: 'm1-t1', name: '第一个任务', detail: '说明要产出的具体内容', dependencies: [],
        verdict: { kind: 'llm', criteria: ['结果具体且可核验'] },
      }],
    }],
  };

  const request = async (path: string, options: RequestInit = {}): Promise<Json> => {
    const response = await fetch(path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`);
    return data;
  };

  const make = (tag: string, className?: string, text?: string): HTMLElement => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const toast = (message: string, error = false): void => {
    const element = byId('toast');
    element.textContent = message;
    element.className = `toast show${error ? ' error' : ''}`;
    window.setTimeout(() => { element.className = 'toast'; }, 3200);
  };

  const setBusy = (busy: boolean): void => {
    app.busy = busy;
    for (const id of ['tick', 'run', 'new-blueprint', 'provider-settings', 'provider-settings-card', 'analyze-provider']) {
      (byId(id) as HTMLButtonElement).disabled = busy;
    }
  };

  const renderStatus = (status: Json): void => {
    app.status = status;
    byId('hero-title').textContent = status.blueprint?.title ?? '还没有蓝图';
    byId('hero-subtitle').textContent = status.blueprint?.description ?? '导入一个目标，夜猫子会按里程碑可靠推进。';
    byId('updated-at').textContent = status.updatedAt ? `更新于 ${new Date(status.updatedAt).toLocaleString()}` : '—';
    const progress = Number(status.progress?.percent ?? 0);
    byId('progress-value').textContent = `${progress}%`;
    byId('progress-copy').textContent = `${status.progress?.done ?? 0} / ${status.progress?.total ?? 0}`;
    (byId('progress-ring') as HTMLElement).style.setProperty('--progress', `${progress * 3.6}deg`);
    const blocked = (status.milestones ?? []).flatMap((m: Json) => m.subtasks ?? []).filter((s: Json) => s.status === 'blocked').length
      + (status.milestones ?? []).filter((m: Json) => m.status === 'blocked' && (m.subtasks ?? []).every((s: Json) => s.status === 'done')).length
      + (status.completion?.status === 'blocked' ? 1 : 0);
    byId('blocked-count').textContent = String(blocked);
    byId('empty-state').hidden = status.hasBlueprint;
    byId('milestones').hidden = !status.hasBlueprint;

    const container = byId('milestones');
    container.replaceChildren();
    for (const milestone of status.milestones ?? []) {
      const card = make('article', 'milestone');
      const head = make('div', 'milestone-head');
      const icon = make('div', `status-icon ${milestone.status}`, milestone.status === 'done' ? '✓' : milestone.status === 'blocked' ? '!' : '•');
      const copy = make('div');
      copy.append(make('div', 'milestone-title', milestone.name), make('div', 'milestone-goal', milestone.goal || '未填写目标'));
      const badge = make('span', 'badge', `${milestone.done}/${milestone.total}`);
      head.append(icon, copy, badge);
      const tasks = make('div', 'task-list');
      for (const task of milestone.subtasks ?? []) {
        const row = make('div', 'task');
        row.append(make('span', `task-dot ${task.status}`));
        const taskCopy = make('div');
        taskCopy.append(make('div', 'task-name', task.name));
        taskCopy.append(make('div', 'task-meta', `${task.verdictKind} · ${task.evidenceCount} 条证据${task.dependencies?.length ? ` · 依赖 ${task.dependencies.join(', ')}` : ''}`));
        if (task.lastEvidence) taskCopy.append(make('div', 'task-evidence', String(task.lastEvidence).slice(0, 150)));
        row.append(taskCopy);
        const actions = make('div', 'task-actions');
        const detail = make('button', 'button small secondary', '详情') as HTMLButtonElement;
        detail.addEventListener('click', () => showTask(task.id));
        actions.append(detail);
        if (task.status === 'blocked') {
          const retry = make('button', 'button small secondary', '重试') as HTMLButtonElement;
          retry.addEventListener('click', () => action(`/subtasks/${encodeURIComponent(task.id)}/retry`, '已重新排队'));
          actions.append(retry);
        }
        if (task.approvable) {
          const approve = make('button', 'button small primary', '人工批准') as HTMLButtonElement;
          approve.addEventListener('click', () => action(`/subtasks/${encodeURIComponent(task.id)}/approve`, '人工批准已记录', { note: '通过 Web Console 批准' }));
          actions.append(approve);
        }
        row.append(actions);
        tasks.append(row);
      }
      if (milestone.status === 'blocked' && (milestone.subtasks ?? []).every((task: Json) => task.status === 'done')) {
        const retryAcceptance = make('button', 'button small secondary', '重新验收') as HTMLButtonElement;
        retryAcceptance.addEventListener('click', () => action(`/milestones/${encodeURIComponent(milestone.id)}/retry`, '里程碑已等待重新验收'));
        head.append(retryAcceptance);
      }
      card.append(head, tasks);
      container.append(card);
    }
    if (status.completion && (
      status.completion.status !== 'pending' ||
      (status.milestones ?? []).every((milestone: Json) => milestone.status === 'done')
    )) {
      const completion = make('article', 'milestone');
      const head = make('div', 'milestone-head');
      const state = status.completion.status;
      const icon = make('div', `status-icon ${state}`, state === 'done' ? '✓' : state === 'blocked' ? '!' : '•');
      const copy = make('div');
      copy.append(
        make('div', 'milestone-title', '整体验收'),
        make('div', 'milestone-goal', status.completion.detail ?? status.blueprint?.definitionOfDone ?? '等待整体验收'),
      );
      head.append(icon, copy, make('span', 'badge', state === 'done' ? '已通过' : state === 'blocked' ? '需处理' : '待验收'));
      if (state === 'blocked') {
        const retry = make('button', 'button small secondary', '重新验收') as HTMLButtonElement;
        retry.addEventListener('click', () => action('/completion/retry', '整体目标已等待重新验收'));
        head.append(retry);
      }
      completion.append(head);
      container.append(completion);
    }
  };

  const renderRuntime = (runtime: Json): void => {
    app.runtime = runtime;
    const phase = app.status?.done && runtime.phase === 'idle'
      ? '目标已完成'
      : phases[runtime.phase] ?? runtime.phase;
    byId('runtime-phase').textContent = phase;
    byId('runtime-copy').textContent = runtime.active
      ? `已推进 ${runtime.reportCount} 轮`
      : app.status?.done && runtime.phase === 'idle'
        ? '所有验收均已通过'
        : runtime.finishedAt ? new Date(runtime.finishedAt).toLocaleString() : '等待任务';
    (byId('run') as HTMLButtonElement).hidden = runtime.active;
    (byId('stop') as HTMLButtonElement).hidden = !runtime.active;
    const detail = byId('runtime-detail');
    detail.replaceChildren();
    const pairs = [
      ['阶段', phase], ['操作 ID', runtime.operationId ? String(runtime.operationId).slice(0, 8) : '—'],
      ['已执行', `${runtime.reportCount ?? 0} / ${runtime.maxTicks ?? '—'} 轮`],
      ['开始', runtime.startedAt ? new Date(runtime.startedAt).toLocaleString() : '—'],
    ];
    for (const pair of pairs) {
      const line = make('div', 'runtime-line'); line.append(make('span', '', pair[0]), make('span', '', pair[1])); detail.append(line);
    }
    if (runtime.error) detail.append(make('p', 'form-error', runtime.error));
    const reports = make('div', 'runtime-reports');
    for (const report of (runtime.recentReports ?? []).slice(-4).reverse()) {
      reports.append(make('div', 'report', `${new Date(report.startedAt).toLocaleTimeString()} · 运行 ${report.ran} · 完成 ${report.completed} · 阻塞 ${report.blocked}${report.done ? ' · 全部完成' : ''}`));
    }
    detail.append(reports);
    scheduleRefresh(runtime.active ? 1500 : 8000);
  };

  const renderCost = (cost: Json): void => {
    byId('cost-value').textContent = `¥${Number(cost.actualCost ?? 0).toFixed(3)}`;
    byId('cost-copy').textContent = cost.calls ? `${cost.calls} 次调用 · 节省 ¥${Number(cost.saved ?? 0).toFixed(3)}` : '尚无模型调用';
  };

  const renderProviderSettingsSummary = (settings: Json): void => {
    app.providerSettings = settings;
    const configured = (settings.providers ?? []).filter((provider: Json) => provider.configured).length;
    const total = (settings.providers ?? []).length || 2;
    const dot = byId('provider-settings-dot');
    dot.className = `settings-dot${configured > 0 ? ' ready' : ''}`;
    byId('provider-settings-label').textContent = configured > 0 ? `模型 ${configured}/${total}` : '模型设置';
  };

  const option = (value: string, label: string): HTMLOptionElement => {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  };

  const policyProvider = (providerId?: string): Json | undefined => {
    const selected = providerId ?? (byId('policy-provider') as HTMLSelectElement).value;
    return (app.providerSettings?.providers ?? []).find((provider: Json) => provider.id === selected);
  };

  const priceText = (quote: Json): string => {
    const multiplier = Number(quote.discount ?? 1);
    const input = Number(quote.model?.inputPrice ?? 0) * multiplier;
    const output = Number(quote.model?.outputPrice ?? 0) * multiplier;
    return `${quote.label ?? '当前价'} · 输入 ¥${input.toFixed(2)} / 输出 ¥${output.toFixed(2)} 每百万 tokens`;
  };

  const renderPolicySummary = (provider: Json): void => {
    const target = document.getElementById(`${provider.id}-policy-summary`);
    if (!target) return;
    const quotes = provider.currentPricing ?? [];
    const source = provider.policySource === 'configured' ? '已配置规则' : '平台自报';
    const quota = (provider.usageLimits ?? []).map((limit: Json) =>
      `${limit.label} ${Number(limit.used).toFixed(limit.unit === 'cost' ? 2 : 0)}/${limit.limit}`).join(' · ');
    const remoteQuota = (provider.remoteUsage?.windows ?? []).map((window: Json) =>
      window.status === 'unlimited' ? `${window.label} 不限量` :
        window.remainingPercent === undefined ? `${window.label} 未知` : `${window.label}剩余 ${Number(window.remainingPercent).toFixed(0)}%`).join(' · ');
    const remoteWarning = provider.remoteUsage?.warning ? ` · ${provider.remoteUsage.warning}` : '';
    target.textContent = `${source} · ${quotes[0] ? priceText(quotes[0]) : '未声明价格'}${quota ? ` · ${quota}` : ''}${remoteQuota ? ` · 官方：${remoteQuota}` : ''}${remoteWarning}`;
  };

  const fillPolicyEditor = (providerId?: string): void => {
    const provider = policyProvider(providerId);
    if (!provider) return;
    const policy = provider.policy ?? {};
    (byId('policy-provider') as HTMLSelectElement).value = provider.id;
    (byId('policy-timezone') as HTMLInputElement).value = policy.timezone ?? 'Asia/Shanghai';
    const rule = (id: string): Json | undefined => (policy.pricingRules ?? []).find((item: Json) => item.id === id);
    const working = rule('ui-working');
    const nonworking = rule('ui-nonworking');
    const windowRule = rule('ui-window');
    (byId('policy-working-multiplier') as HTMLInputElement).value = working?.rate?.multiplier ?? '';
    (byId('policy-nonworking-multiplier') as HTMLInputElement).value = nonworking?.rate?.multiplier ?? '';
    (byId('policy-window-start') as HTMLInputElement).value = windowRule?.windows?.[0]?.start ?? '';
    (byId('policy-window-end') as HTMLInputElement).value = windowRule?.windows?.[0]?.end ?? '';
    (byId('policy-window-multiplier') as HTMLInputElement).value = windowRule?.rate?.multiplier ?? '';
    const quota = (policy.usageLimits ?? []).find((item: Json) => item.id === 'ui-period-limit')
      ?? policy.usageLimits?.[0];
    (byId('policy-quota-period') as HTMLSelectElement).value = quota?.period ?? '';
    (byId('policy-quota-window') as HTMLInputElement).value = quota?.windowMinutes ?? '';
    (byId('policy-quota-unit') as HTMLSelectElement).value = quota?.unit ?? 'tokens';
    (byId('policy-quota-limit') as HTMLInputElement).value = quota?.limit ?? '';
    (byId('policy-nonworking-dates') as HTMLInputElement).value = (policy.nonWorkingDates ?? []).join(', ');
    (byId('policy-working-dates') as HTMLInputElement).value = (policy.workingDates ?? []).join(', ');
    (byId('policy-json') as HTMLTextAreaElement).value = JSON.stringify(policy, null, 2);
  };

  const populateProviderSelectors = (settings: Json): void => {
    const preferred = byId('preferred-provider') as HTMLSelectElement;
    const selectedPreferred = settings.preferredProvider ?? 'auto';
    preferred.replaceChildren(option('auto', '自动选择（推荐）'));
    const policySelect = byId('policy-provider') as HTMLSelectElement;
    const selectedPolicy = policySelect.value;
    policySelect.replaceChildren();
    for (const provider of settings.providers ?? []) {
      preferred.append(option(provider.id, `${provider.name} 优先`));
      policySelect.append(option(provider.id, provider.name));
    }
    preferred.value = selectedPreferred;
    (byId('provider-priority') as HTMLSelectElement).value = settings.priority ?? 'balanced';
    fillPolicyEditor((settings.providers ?? []).some((provider: Json) => provider.id === selectedPolicy) ? selectedPolicy : settings.providers?.[0]?.id);
  };

  const fillProviderSettingsForm = (settings: Json): void => {
    renderProviderSettingsSummary(settings);
    populateProviderSelectors(settings);
    for (const providerId of managedProviderIds) {
      const provider = (settings.providers ?? []).find((item: Json) => item.id === providerId) ?? {};
      const status = byId(`${providerId}-status`);
      status.textContent = provider.configured ? '已配置' : '未配置';
      status.className = `provider-status${provider.configured ? ' configured' : ''}`;
      const source = byId(`${providerId}-source`);
      source.textContent = provider.source === 'local'
        ? '已安全保存在本机'
        : provider.source === 'environment'
          ? '由启动环境变量提供'
          : providerId === 'openai-compatible' && provider.configuration?.apiKeyRequired === false
            ? '接口配置为无需密钥'
          : '尚未提供密钥';
      const input = byId(`${providerId}-key`) as HTMLInputElement;
      input.value = '';
      input.placeholder = provider.configured ? '输入新密钥可替换；留空保持不变' : '粘贴 API Key';
      (byId(`clear-${providerId}-key`) as HTMLButtonElement).hidden = provider.source !== 'local';
    }
    const custom = (settings.providers ?? []).find((item: Json) => item.id === 'openai-compatible')?.configuration ?? {};
    (byId('custom-openai-enabled') as HTMLInputElement).checked = custom.enabled ?? false;
    (byId('custom-openai-api-key-required') as HTMLInputElement).checked = custom.apiKeyRequired ?? true;
    (byId('custom-openai-name') as HTMLInputElement).value = custom.name ?? '自定义 OpenAI 兼容';
    (byId('custom-openai-base-url') as HTMLInputElement).value = custom.baseUrl ?? '';
    const models = custom.models ?? [];
    (byId('custom-openai-chat-models') as HTMLInputElement).value = models
      .filter((model: Json) => model.kind === 'chat').map((model: Json) => model.name).join(', ');
    (byId('custom-openai-reasoner-models') as HTMLInputElement).value = models
      .filter((model: Json) => model.kind === 'reasoner').map((model: Json) => model.name).join(', ');
    const firstModel = models[0];
    (byId('custom-openai-input-price') as HTMLInputElement).value = firstModel?.inputPrice ?? '';
    (byId('custom-openai-output-price') as HTMLInputElement).value = firstModel?.outputPrice ?? '';
    (byId('custom-openai-cache-price') as HTMLInputElement).value = firstModel?.cacheHitPrice ?? '';
    (byId('custom-openai-context-window') as HTMLInputElement).value = firstModel?.contextWindow ?? 128000;
    byId('openai-compatible-name-heading').textContent = custom.name ?? '自定义 OpenAI 兼容';
    for (const provider of settings.providers ?? []) renderPolicySummary(provider);
  };

  const openProviderSettings = async (): Promise<void> => {
    const dialog = byId('provider-dialog') as HTMLDialogElement;
    byId('provider-error').textContent = '';
    dialog.showModal();
    try {
      const settings = await request('/settings/providers');
      fillProviderSettingsForm(settings);
      window.setTimeout(() => (byId('preferred-provider') as HTMLSelectElement).focus(), 0);
    } catch (error) {
      byId('provider-error').textContent = (error as Error).message;
    }
  };

  const saveProviderSettings = async (): Promise<void> => {
    const save = byId('save-provider-settings') as HTMLButtonElement;
    const error = byId('provider-error');
    const apiKeys: Json = {};
    for (const providerId of managedProviderIds) {
      const key = (byId(`${providerId}-key`) as HTMLInputElement).value.trim();
      if (key) apiKeys[providerId] = key;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      const settings = await request('/settings/providers', {
        method: 'PUT',
        body: JSON.stringify({
          preferredProvider: (byId('preferred-provider') as HTMLSelectElement).value,
          priority: (byId('provider-priority') as HTMLSelectElement).value,
          customOpenAI: customOpenAISettingsFromForm(),
          ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {}),
        }),
      });
      fillProviderSettingsForm(settings);
      toast('模型设置已保存，后续调用立即生效');
      await refresh();
    } catch (reason) {
      error.textContent = (reason as Error).message;
    } finally {
      save.disabled = false;
    }
  };

  const customOpenAISettingsFromForm = (): Json => {
    const splitModels = (id: string): string[] => (byId(id) as HTMLInputElement).value
      .split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean);
    const chatModels = splitModels('custom-openai-chat-models');
    const reasonerModels = splitModels('custom-openai-reasoner-models');
    const modelNames = [...chatModels, ...reasonerModels];
    const inputPriceText = (byId('custom-openai-input-price') as HTMLInputElement).value;
    const outputPriceText = (byId('custom-openai-output-price') as HTMLInputElement).value;
    const cachePriceText = (byId('custom-openai-cache-price') as HTMLInputElement).value;
    const contextText = (byId('custom-openai-context-window') as HTMLInputElement).value;
    const enabled = (byId('custom-openai-enabled') as HTMLInputElement).checked;
    if (enabled && modelNames.length === 0) throw new Error('启用自定义 OpenAI 时至少填写一个模型 ID。');
    if (modelNames.length > 0 && (inputPriceText === '' || outputPriceText === '' || contextText === '')) {
      throw new Error('自定义模型需要填写输入价、输出价和上下文窗口；免费接口价格可填 0。');
    }
    const shared = modelNames.length > 0 ? {
      inputPrice: Number(inputPriceText),
      outputPrice: Number(outputPriceText),
      ...(cachePriceText === '' ? {} : { cacheHitPrice: Number(cachePriceText) }),
      contextWindow: Number(contextText),
    } : {};
    return {
      enabled,
      name: (byId('custom-openai-name') as HTMLInputElement).value.trim() || '自定义 OpenAI 兼容',
      baseUrl: (byId('custom-openai-base-url') as HTMLInputElement).value.trim(),
      apiKeyRequired: (byId('custom-openai-api-key-required') as HTMLInputElement).checked,
      models: [
        ...chatModels.map((name) => ({ name, kind: 'chat', ...shared })),
        ...reasonerModels.map((name) => ({ name, kind: 'reasoner', ...shared })),
      ],
    };
  };

  const renderProviderRecommendation = (recommendation: Json): void => {
    app.providerRecommendation = recommendation;
    const container = byId('provider-recommendation');
    container.hidden = false;
    container.replaceChildren();
    const head = make('div', 'recommendation-head');
    head.append(make('b', '', recommendation.summary), make('small', '', recommendation.analyzedBy === 'ai' ? 'AI 已识别意图' : '本地规则匹配'));
    container.append(head);
    for (const warning of recommendation.warnings ?? []) container.append(make('p', 'recommendation-warning', warning));
    const grid = make('div', 'recommendation-grid');
    for (const candidate of recommendation.candidates ?? []) {
      const recommended = candidate.optionId === recommendation.recommendedOptionId;
      const card = make('article', `recommendation-card${recommended ? ' recommended' : ''}${candidate.eligible ? '' : ' unavailable'}`);
      const title = make('div', 'recommendation-title');
      title.append(make('b', '', `${candidate.providerName} / ${candidate.model}`), make('span', '', recommended ? '推荐' : candidate.eligible ? '可选' : '不可用'));
      card.append(title, make('p', '', `当前预计 ¥${Number(candidate.estimatedCost).toFixed(4)} · ${priceText(candidate.currentRate)}`));
      if (candidate.betterAt) {
        card.append(make('p', '', `${new Date(candidate.betterAt).toLocaleString()} 后预计 ¥${Number(candidate.betterEstimatedCost).toFixed(4)}`));
      }
      const tags = make('div', 'recommendation-tags');
      for (const reason of candidate.reasons ?? []) tags.append(make('span', '', reason));
      for (const limit of candidate.usageLimits ?? []) tags.append(make('span', '', `${limit.label} 剩余 ${Number(limit.remaining).toFixed(limit.unit === 'cost' ? 2 : 0)}`));
      for (const window of candidate.remoteUsage?.windows ?? []) {
        tags.append(make('span', '', window.status === 'unlimited'
          ? `${window.label} 不限量`
          : `${window.label}剩余 ${Number(window.remainingPercent ?? 0).toFixed(0)}%`));
      }
      card.append(tags);
      for (const warning of candidate.warnings ?? []) card.append(make('p', 'recommendation-warning', warning));
      if (candidate.eligible) {
        const apply = make('button', `button small ${recommended ? 'primary' : 'secondary'}`, recommended ? '采用推荐' : '选择此方案') as HTMLButtonElement;
        apply.type = 'button';
        apply.addEventListener('click', () => void applyProviderRecommendation(candidate.optionId));
        card.append(apply);
      }
      grid.append(card);
    }
    container.append(grid);
  };

  const analyzeProviderRequest = async (): Promise<void> => {
    const input = byId('provider-request') as HTMLTextAreaElement;
    const requestText = input.value.trim();
    if (!requestText) {
      byId('provider-error').textContent = '请先描述任务规模、预算或时效要求。';
      input.focus();
      return;
    }
    const button = byId('analyze-provider') as HTMLButtonElement;
    button.disabled = true;
    byId('provider-error').textContent = '';
    try {
      renderProviderRecommendation(await request('/settings/providers/recommend', {
        method: 'POST', body: JSON.stringify({ request: requestText }),
      }));
    } catch (error) {
      byId('provider-error').textContent = (error as Error).message;
    } finally {
      button.disabled = false;
    }
  };

  const applyProviderRecommendation = async (optionId: string): Promise<void> => {
    const error = byId('provider-error');
    error.textContent = '';
    try {
      const result = await request('/settings/providers/apply', {
        method: 'POST',
        body: JSON.stringify({ optionId, priority: app.providerRecommendation?.interpretation?.priority }),
      });
      fillProviderSettingsForm(result.settings);
      toast(`已应用 ${result.providerId} / ${result.model}，下一次调用立即使用`);
      await refresh();
    } catch (reason) {
      error.textContent = (reason as Error).message;
    }
  };

  const parseDateList = (value: string): string[] => value
    .split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);

  const commonPolicy = (): Json => {
    const existing = policyProvider()?.policy ?? {};
    const timezone = (byId('policy-timezone') as HTMLInputElement).value.trim();
    const working = (byId('policy-working-multiplier') as HTMLInputElement).value;
    const nonworking = (byId('policy-nonworking-multiplier') as HTMLInputElement).value;
    const start = (byId('policy-window-start') as HTMLInputElement).value;
    const end = (byId('policy-window-end') as HTMLInputElement).value;
    const windowMultiplier = (byId('policy-window-multiplier') as HTMLInputElement).value;
    const pricingRules: Json[] = (existing.pricingRules ?? []).filter((rule: Json) =>
      !['ui-working', 'ui-nonworking', 'ui-window'].includes(rule.id));
    if (working !== '') pricingRules.push({ id: 'ui-working', label: '工作日价格', dayType: 'working-day', rate: { multiplier: Number(working) }, priority: 10 });
    if (nonworking !== '') pricingRules.push({ id: 'ui-nonworking', label: '非工作日价格', dayType: 'non-working-day', rate: { multiplier: Number(nonworking) }, priority: 10 });
    if (start && end && windowMultiplier !== '') pricingRules.push({ id: 'ui-window', label: '优惠时段', windows: [{ start, end }], rate: { multiplier: Number(windowMultiplier) }, priority: 20 });
    const quotaPeriod = (byId('policy-quota-period') as HTMLSelectElement).value;
    const quotaWindow = (byId('policy-quota-window') as HTMLInputElement).value;
    const quotaLimit = (byId('policy-quota-limit') as HTMLInputElement).value;
    const existingQuota = (existing.usageLimits ?? []).find((limit: Json) => limit.id === 'ui-period-limit')
      ?? existing.usageLimits?.[0];
    const usageLimits = (existing.usageLimits ?? []).filter((limit: Json) => limit.id !== existingQuota?.id);
    if (quotaPeriod && quotaLimit !== '') usageLimits.push({
      id: 'ui-period-limit',
      label: `${quotaPeriod === 'rolling' ? `${quotaWindow || '?'} 分钟滚动` : quotaPeriod === 'day' ? '每日' : quotaPeriod === 'week' ? '每周' : '每月'}额度`,
      period: quotaPeriod,
      ...(quotaPeriod === 'rolling' ? { windowMinutes: Number(quotaWindow) } : {}),
      unit: (byId('policy-quota-unit') as HTMLSelectElement).value,
      limit: Number(quotaLimit), warningAt: 0.8,
    });
    return {
      timezone,
      weekendDays: existing.weekendDays ?? [0, 6],
      nonWorkingDates: parseDateList((byId('policy-nonworking-dates') as HTMLInputElement).value),
      workingDates: parseDateList((byId('policy-working-dates') as HTMLInputElement).value),
      defaultRate: existing.defaultRate ?? { multiplier: 1 },
      pricingRules,
      usageLimits,
    };
  };

  const saveProviderPolicy = async (policy: Json): Promise<void> => {
    const providerId = (byId('policy-provider') as HTMLSelectElement).value;
    const error = byId('provider-error');
    error.textContent = '';
    try {
      const settings = await request('/settings/providers', {
        method: 'PUT', body: JSON.stringify({ profiles: { [providerId]: policy } }),
      });
      fillProviderSettingsForm(settings);
      toast('资费与额度规则已保存，路由已立即重算');
    } catch (reason) {
      error.textContent = (reason as Error).message;
    }
  };

  const restoreProviderPolicy = async (): Promise<void> => {
    const providerId = (byId('policy-provider') as HTMLSelectElement).value;
    if (!window.confirm('恢复平台自报画像？当前平台的人工资费与额度覆盖会被删除。')) return;
    try {
      const settings = await request('/settings/providers', {
        method: 'PUT', body: JSON.stringify({ clearProfiles: [providerId] }),
      });
      fillProviderSettingsForm(settings);
      toast('已恢复平台自报资费画像');
    } catch (reason) {
      byId('provider-error').textContent = (reason as Error).message;
    }
  };

  const clearProviderKey = async (providerId: ManagedProviderId): Promise<void> => {
    const name = (app.providerSettings?.providers ?? [])
      .find((provider: Json) => provider.id === providerId)?.name ?? providerId;
    if (!window.confirm(`删除保存在本机的 ${name} API Key？`)) return;
    const error = byId('provider-error');
    error.textContent = '';
    try {
      const settings = await request('/settings/providers', {
        method: 'PUT',
        body: JSON.stringify({ clear: [providerId] }),
      });
      fillProviderSettingsForm(settings);
      toast(`${name} 本地密钥已删除`);
      await refresh();
    } catch (reason) {
      error.textContent = (reason as Error).message;
    }
  };


  const renderPlugins = (catalog: Json, settings: Json): void => {
    const container = byId('plugins'); container.replaceChildren();
    for (const provider of catalog.providers ?? []) {
      const item = make('div', 'plugin'); const top = make('div', 'plugin-top');
      const providerSetting = (settings.providers ?? []).find((candidate: Json) => candidate.id === provider.id);
      const meta = make('div', 'plugin-provider-meta');
      meta.append(make('small', '', provider.source === 'core' ? '内建' : provider.pluginId));
      if (providerSetting) {
        meta.append(make('small', `provider-state${providerSetting.configured ? ' configured' : ''}`, providerSetting.configured ? '可用' : '待配置'));
      }
      top.append(make('b', '', provider.name), meta);
      item.append(top, make('div', 'plugin-models', (provider.models ?? []).join(' · ') || '未声明模型'));
      container.append(item);
    }
    for (const plugin of catalog.plugins ?? []) {
      const item = make('div', 'plugin'); const top = make('div', 'plugin-top');
      top.append(make('b', '', plugin.name), make('small', '', `v${plugin.version}`));
      item.append(top, make('div', 'plugin-models', `${plugin.contributions.map((c: Json) => c.kind).join(' · ') || '无贡献'}${plugin.permissions?.length ? ` · 权限 ${plugin.permissions.join(', ')}` : ''}`));
      container.append(item);
    }
    if (!container.childElementCount) container.append(make('p', 'muted', '尚未加载插件。启动时使用 --plugin 显式加载可信本地模块。'));
  };

  const refresh = async (): Promise<void> => {
    try {
      const [status, runtime, cost, plugins, providerSettings] = await Promise.all([
        request('/status'), request('/runtime'), request('/cost'), request('/plugins'), request('/settings/providers'),
      ]);
      renderProviderSettingsSummary(providerSettings);
      renderStatus(status); renderRuntime(runtime); renderCost(cost); renderPlugins(plugins, providerSettings);
      const connection = byId('connection'); connection.className = 'pill online'; connection.lastChild!.textContent = '本地服务正常';
    } catch (error) {
      const connection = byId('connection'); connection.className = 'pill offline'; connection.lastChild!.textContent = '连接失败';
      toast((error as Error).message, true);
      scheduleRefresh(5000);
    }
  };

  const scheduleRefresh = (ms: number): void => {
    if (app.timer !== null) window.clearTimeout(app.timer);
    app.timer = window.setTimeout(() => { void refresh(); }, ms);
  };

  const action = async (path: string, success: string, body: Json = {}): Promise<void> => {
    if (app.busy) return;
    setBusy(true);
    try { await request(path, { method: 'POST', body: JSON.stringify(body) }); toast(success); await refresh(); }
    catch (error) { toast((error as Error).message, true); }
    finally { setBusy(false); }
  };

  const showTask = async (id: string): Promise<void> => {
    try {
      const data = await request(`/subtasks/${encodeURIComponent(id)}`);
      byId('detail-title').textContent = data.subtask.name;
      const content = byId('detail-content'); content.replaceChildren();
      content.append(make('p', 'muted', data.subtask.detail || '无详细说明'));
      for (const item of data.subtask.evidence ?? []) {
        const evidence = make('section', 'evidence');
        evidence.append(make('small', 'muted', `${item.kind} · ${new Date(item.at).toLocaleString()}`));
        const pre = make('pre'); pre.textContent = item.content ?? item.path ?? '（无内容）'; evidence.append(pre); content.append(evidence);
      }
      if (!(data.subtask.evidence ?? []).length) content.append(make('p', 'muted', '还没有证据。'));
      (byId('detail-dialog') as HTMLDialogElement).showModal();
    } catch (error) { toast((error as Error).message, true); }
  };

  const openBlueprint = (): void => {
    const textarea = byId('blueprint-json') as HTMLTextAreaElement;
    if (!textarea.value) textarea.value = JSON.stringify(blueprintTemplate, null, 2);
    (byId('blueprint-dialog') as HTMLDialogElement).showModal();
  };

  byId('refresh').addEventListener('click', () => void refresh());
  byId('provider-settings').addEventListener('click', () => void openProviderSettings());
  byId('provider-settings-card').addEventListener('click', () => void openProviderSettings());
  byId('close-provider-settings').addEventListener('click', () => (byId('provider-dialog') as HTMLDialogElement).close());
  byId('cancel-provider-settings').addEventListener('click', () => (byId('provider-dialog') as HTMLDialogElement).close());
  for (const providerId of managedProviderIds) {
    byId(`clear-${providerId}-key`).addEventListener('click', () => void clearProviderKey(providerId));
  }
  byId('analyze-provider').addEventListener('click', () => void analyzeProviderRequest());
  byId('provider-request').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void analyzeProviderRequest();
    }
  });
  byId('policy-provider').addEventListener('change', () => fillPolicyEditor());
  byId('save-common-policy').addEventListener('click', () => void saveProviderPolicy(commonPolicy()));
  byId('save-policy-json').addEventListener('click', () => {
    try {
      void saveProviderPolicy(JSON.parse((byId('policy-json') as HTMLTextAreaElement).value));
    } catch (error) {
      byId('provider-error').textContent = `规则 JSON 无法解析：${(error as Error).message}`;
    }
  });
  byId('restore-provider-policy').addEventListener('click', () => void restoreProviderPolicy());
  byId('provider-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveProviderSettings();
  });
  byId('new-blueprint').addEventListener('click', openBlueprint);
  document.querySelector('[data-action="open-blueprint"]')?.addEventListener('click', openBlueprint);
  byId('tick').addEventListener('click', () => void action('/tick', '已推进一轮'));
  byId('run').addEventListener('click', () => void action('/runtime/start', '后台运行已启动', { maxTicks: 100 }));
  byId('stop').addEventListener('click', () => void action('/runtime/stop', '已请求停止'));
  byId('close-detail').addEventListener('click', () => (byId('detail-dialog') as HTMLDialogElement).close());
  byId('blueprint-form').addEventListener('submit', async (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === 'cancel') return;
    event.preventDefault();
    const error = byId('blueprint-error'); error.textContent = '';
    try {
      const blueprint = JSON.parse((byId('blueprint-json') as HTMLTextAreaElement).value);
      if (app.status?.hasBlueprint && !window.confirm('这会替换当前单运行状态，确定继续吗？')) return;
      await request('/blueprint/raw', { method: 'POST', body: JSON.stringify(blueprint) });
      (byId('blueprint-dialog') as HTMLDialogElement).close(); toast('蓝图已导入'); await refresh();
    } catch (err) { error.textContent = (err as Error).message; }
  });

  void refresh();
}

const APP_JS = `(${clientApp.toString()})();`;

const ASSETS: Record<string, WebAsset> = {
  '/': { contentType: 'text/html; charset=utf-8', cacheControl: 'no-store', body: HTML },
  '/index.html': { contentType: 'text/html; charset=utf-8', cacheControl: 'no-store', body: HTML },
  '/app.css': { contentType: 'text/css; charset=utf-8', cacheControl: 'public, max-age=300', body: CSS + PROVIDER_CSS },
  '/app.js': { contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-store', body: APP_JS },
};

export function getWebAsset(pathname: string): WebAsset | null {
  return ASSETS[pathname] ?? null;
}
