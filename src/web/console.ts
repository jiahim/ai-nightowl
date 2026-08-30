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
          <div class="panel-heading"><div><p class="eyebrow">Capabilities</p><h2>插件与 Provider</h2></div><span class="preview-tag">可信本地</span></div>
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

function clientApp(): void {
  type Json = Record<string, any>;
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const app: { status: Json | null; runtime: Json | null; timer: number | null; busy: boolean } = {
    status: null,
    runtime: null,
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
    for (const id of ['tick', 'run', 'new-blueprint']) {
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

  const renderPlugins = (catalog: Json): void => {
    const container = byId('plugins'); container.replaceChildren();
    for (const provider of catalog.providers ?? []) {
      const item = make('div', 'plugin'); const top = make('div', 'plugin-top');
      top.append(make('b', '', provider.name), make('small', '', provider.source === 'core' ? '内建' : provider.pluginId));
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
      const [status, runtime, cost, plugins] = await Promise.all([
        request('/status'), request('/runtime'), request('/cost'), request('/plugins'),
      ]);
      renderStatus(status); renderRuntime(runtime); renderCost(cost); renderPlugins(plugins);
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
  '/app.css': { contentType: 'text/css; charset=utf-8', cacheControl: 'public, max-age=300', body: CSS },
  '/app.js': { contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-store', body: APP_JS },
};

export function getWebAsset(pathname: string): WebAsset | null {
  return ASSETS[pathname] ?? null;
}
