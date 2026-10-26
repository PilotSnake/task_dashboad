/* ============================================================
   任务面板 · Task Board
   纯本地、零依赖。数据保存在浏览器 localStorage。
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'taskboard.v1';

  var COLUMNS = [
    { key: 'todo', label: '待办', empty: '拖拽任务到这里' },
    { key: 'doing', label: '进行中', empty: '还没有正在做的事' },
    { key: 'done', label: '已完成', empty: '完成的任务会出现在这里' }
  ];

  var PRIO = {
    high: { label: '高', order: 0 },
    medium: { label: '中', order: 1 },
    low: { label: '低', order: 2 }
  };

  var VIEWS = {
    all: { title: '全部任务', sub: '管理你的日常事项' },
    today: { title: '今天', sub: '今天到期的事项' },
    upcoming: { title: '未来 7 天', sub: '接下来一周需要关注' },
    overdue: { title: '已逾期', sub: '需要尽快处理' },
    done: { title: '已完成', sub: '已经收尾的任务' }
  };

  var state = {
    tasks: [],
    theme: 'light',
    mode: 'board',
    view: 'all',
    tag: null,
    priority: null,
    q: ''
  };

  var editingId = null;
  var draft = { status: 'todo', priority: 'medium' };
  var toastTimer = null;
  var hadLocalData = false;

  /* ---------------- helpers ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function isoDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function daysFromToday(due) {
    var a = new Date(due + 'T00:00:00');
    var b = new Date(isoDate() + 'T00:00:00');
    return Math.round((a - b) / 86400000);
  }

  function getTask(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function allTags() {
    var map = {};
    state.tasks.forEach(function (t) {
      (t.tags || []).forEach(function (tag) { map[tag] = (map[tag] || 0) + 1; });
    });
    return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; })
      .map(function (k) { return { name: k, count: map[k] }; });
  }

  /* ---------------- storage ---------------- */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tasks: state.tasks,
        theme: state.theme,
        mode: state.mode
      }));
    } catch (e) {
      toast('保存失败：浏览器存储不可用');
    }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }

    if (raw) {
      hadLocalData = true;
      try {
        var data = JSON.parse(raw);
        state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
        state.theme = data.theme === 'dark' ? 'dark' : 'light';
        state.mode = data.mode === 'list' ? 'list' : 'board';
      } catch (e) { /* 数据损坏则使用空列表 */ }
    } else {
      state.tasks = seedTasks();
      save();
    }
  }

  function seedTasks() {
    var now = Date.now();
    var today = isoDate();
    var d = function (n) {
      var x = new Date();
      x.setDate(x.getDate() + n);
      return isoDate(x);
    };
    return [
      { id: uid(), title: '梳理本周任务清单', notes: '把脑子里的事情全部倒出来，再排优先级。', status: 'doing', priority: 'high', tags: ['计划'], due: today, createdAt: now - 5000, updatedAt: now },
      { id: uid(), title: '完成产品首页视觉稿', notes: '重点打磨首屏信息层级与留白。', status: 'doing', priority: 'medium', tags: ['设计'], due: d(2), createdAt: now - 4000, updatedAt: now },
      { id: uid(), title: '整理项目文档目录', notes: '', status: 'todo', priority: 'low', tags: ['文档'], due: d(5), createdAt: now - 3000, updatedAt: now },
      { id: uid(), title: '和团队同步进度', notes: '准备 3 条要点：进展、风险、需要的支持。', status: 'todo', priority: 'high', tags: ['协作'], due: d(1), createdAt: now - 2000, updatedAt: now },
      { id: uid(), title: '搭建任务面板原型', notes: '本地轻量方案，双击即可使用。', status: 'done', priority: 'medium', tags: ['开发'], due: '', createdAt: now - 1000, updatedAt: now, doneAt: now }
    ];
  }

  /* ---------------- filtering ---------------- */
  function visibleTasks() {
    var today = isoDate();
    return state.tasks.filter(function (t) {
      var tags = t.tags || [];

      if (state.view === 'done' && t.status !== 'done') return false;
      if (state.view === 'today' && (t.status === 'done' || t.due !== today)) return false;
      if (state.view === 'overdue' && (t.status === 'done' || !t.due || t.due >= today)) return false;
      if (state.view === 'upcoming') {
        if (t.status === 'done' || !t.due) return false;
        var diff = daysFromToday(t.due);
        if (diff < 0 || diff > 7) return false;
      }

      if (state.tag && tags.indexOf(state.tag) === -1) return false;
      if (state.priority && t.priority !== state.priority) return false;

      if (state.q) {
        var q = state.q.toLowerCase();
        var hay = (t.title + ' ' + (t.notes || '') + ' ' + tags.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function countFor(view) {
    var today = isoDate();
    return state.tasks.filter(function (t) {
      if (view === 'all') return true;
      if (view === 'done') return t.status === 'done';
      if (view === 'today') return t.status !== 'done' && t.due === today;
      if (view === 'overdue') return t.status !== 'done' && !!t.due && t.due < today;
      if (view === 'upcoming') {
        if (t.status === 'done' || !t.due) return false;
        var diff = daysFromToday(t.due);
        return diff >= 0 && diff <= 7;
      }
      return true;
    }).length;
  }

  /* ---------------- rendering ---------------- */
  function render() {
    renderNav();
    renderSideChips();
    renderHeader();
    renderStats();
    renderProgress();

    if (state.mode === 'board') {
      $('#board').hidden = false;
      $('#listview').hidden = true;
      renderBoard();
    } else {
      $('#board').hidden = true;
      $('#listview').hidden = false;
      renderList();
    }

    $$('#viewSwitch button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === state.mode);
    });
  }

  function renderNav() {
    $$('#nav .nav-item').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.view === state.view);
    });
    $$('[data-count]').forEach(function (el) {
      el.textContent = countFor(el.dataset.count);
    });
  }

  function renderSideChips() {
    var prioBox = $('#prioChips');
    prioBox.innerHTML = ['high', 'medium', 'low'].map(function (p) {
      var n = state.tasks.filter(function (t) { return t.priority === p && t.status !== 'done'; }).length;
      return '<button class="chip' + (state.priority === p ? ' is-active' : '') + '" data-prio="' + p + '">' +
        '<span class="d" style="background:' + prioColor(p) + '"></span>' + PRIO[p].label +
        '<span class="n">' + n + '</span></button>';
    }).join('');

    var tagBox = $('#tagChips');
    var tags = allTags();
    if (!tags.length) {
      tagBox.innerHTML = '<span class="chips-empty">还没有标签</span>';
    } else {
      tagBox.innerHTML = tags.map(function (t) {
        return '<button class="chip' + (state.tag === t.name ? ' is-active' : '') + '" data-tag="' + esc(t.name) + '">' +
          esc(t.name) + '<span class="n">' + t.count + '</span></button>';
      }).join('');
    }
    $('#btnClearTag').hidden = !state.tag && !state.priority;
  }

  function prioColor(p) {
    return p === 'high' ? 'var(--high)' : p === 'medium' ? 'var(--med)' : 'var(--low)';
  }

  function renderHeader() {
    var v = VIEWS[state.view];
    $('#viewTitle').textContent = v.title;
    var bits = [v.sub];
    if (state.tag) bits.push('标签：' + state.tag);
    if (state.priority) bits.push('优先级：' + PRIO[state.priority].label);
    if (state.q) bits.push('搜索：' + state.q);
    $('#viewSub').textContent = bits.join(' · ');
  }

  function renderStats() {
    var today = isoDate();
    var total = state.tasks.length;
    var doing = state.tasks.filter(function (t) { return t.status === 'doing'; }).length;
    var done = state.tasks.filter(function (t) { return t.status === 'done'; }).length;
    var todayDue = state.tasks.filter(function (t) { return t.status !== 'done' && t.due === today; }).length;
    var overdue = state.tasks.filter(function (t) { return t.status !== 'done' && !!t.due && t.due < today; }).length;

    $('#stats').innerHTML =
      statCard('全部任务', total, '共 ' + total + ' 项', 'var(--text-3)') +
      statCard('进行中', doing, '已完成 ' + done, 'var(--accent)') +
      statCard('今日到期', todayDue, todayDue ? '别忘了处理' : '今天很轻松', 'var(--med)') +
      statCard('已逾期', overdue, overdue ? '需要尽快处理' : '一切正常', 'var(--high)', overdue > 0);
  }

  function statCard(label, value, hint, color, danger) {
    return '<div class="stat' + (danger ? ' is-danger' : '') + '">' +
      '<div class="stat-label" style="color:' + color + '"><span class="d"></span>' + label + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-hint">' + hint + '</div>' +
      '</div>';
  }

  function renderProgress() {
    var total = state.tasks.length;
    var done = state.tasks.filter(function (t) { return t.status === 'done'; }).length;
    var pct = total ? Math.round((done / total) * 100) : 0;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = pct + '%  (' + done + '/' + total + ')';
  }

  function sortColumn(list, key) {
    return list.slice().sort(function (a, b) {
      if (key === 'done') return (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0);
      var pa = (PRIO[a.priority] || PRIO.medium).order;
      var pb = (PRIO[b.priority] || PRIO.medium).order;
      if (pa !== pb) return pa - pb;
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function renderBoard() {
    var list = visibleTasks();
    var html = COLUMNS.map(function (col) {
      var items = sortColumn(list.filter(function (t) { return t.status === col.key; }), col.key);
      var body = items.length
        ? items.map(cardHTML).join('')
        : '<div class="col-empty">' + col.empty + '</div>';
      return '<section class="column" data-col="' + col.key + '">' +
        '<header class="col-head">' +
        '<span class="dot dot-' + col.key + '"></span>' +
        '<h2>' + col.label + '</h2>' +
        '<span class="col-count">' + items.length + '</span>' +
        '<button class="col-add" data-add="' + col.key + '" title="在此列新建任务">+</button>' +
        '</header>' +
        '<div class="col-body">' + body + '</div>' +
        '</section>';
    }).join('');

    if (!state.tasks.length) {
      html = '<div class="empty" style="grid-column:1/-1">' +
        '<div class="empty-ico">☰</div>' +
        '<h3>还没有任务</h3>' +
        '<p>点击右上角「新建任务」开始，或按 N 键</p>' +
        '</div>';
    } else if (!visibleTasks().length) {
      html = '<div class="empty" style="grid-column:1/-1">' +
        '<div class="empty-ico">⌕</div>' +
        '<h3>没有匹配的任务</h3>' +
        '<p>换个筛选条件或清空搜索试试</p>' +
        '</div>';
    }

    $('#board').innerHTML = html;
  }

  function cardHTML(t) {
    var tags = (t.tags || []).map(function (g) {
      return '<span class="tag">' + esc(g) + '</span>';
    }).join('');
    var due = dueHTML(t);
    return '<article class="card' + (t.status === 'done' ? ' is-done' : '') + '" draggable="true" data-id="' + t.id + '" data-prio="' + t.priority + '">' +
      '<div class="card-top">' +
      '<span class="prio prio-' + t.priority + '">' + PRIO[t.priority].label + '</span>' +
      '<div class="card-actions">' +
      '<button data-edit="' + t.id + '" title="编辑">✎</button>' +
      '<button class="del" data-del="' + t.id + '" title="删除">✕</button>' +
      '</div></div>' +
      '<h3>' + esc(t.title) + '</h3>' +
      (t.notes ? '<p class="card-notes">' + esc(t.notes) + '</p>' : '') +
      (tags ? '<div class="card-tags">' + tags + '</div>' : '') +
      (due ? '<div class="card-foot">' + due + '</div>' : '') +
      '</article>';
  }

  function dueHTML(t) {
    if (!t.due) return '';
    var diff = daysFromToday(t.due);
    var label, cls;
    if (t.status === 'done') {
      label = t.due.slice(5).replace('-', '/');
      cls = '';
    } else if (diff < 0) {
      label = '逾期 ' + (-diff) + ' 天';
      cls = ' is-overdue';
    } else if (diff === 0) {
      label = '今天到期';
      cls = ' is-today';
    } else if (diff === 1) {
      label = '明天到期';
      cls = ' is-soon';
    } else if (diff <= 7) {
      label = diff + ' 天后';
      cls = ' is-soon';
    } else {
      label = t.due.slice(5).replace('-', '/');
      cls = '';
    }
    return '<span class="due' + cls + '">◔ ' + label + '</span>';
  }

  function renderList() {
    var items = visibleTasks().sort(function (a, b) {
      if (a.status === 'done' && b.status !== 'done') return 1;
      if (b.status === 'done' && a.status !== 'done') return -1;
      var pa = (PRIO[a.priority] || PRIO.medium).order;
      var pb = (PRIO[b.priority] || PRIO.medium).order;
      if (pa !== pb) return pa - pb;
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    var box = $('#listview');
    if (!items.length) {
      box.innerHTML = '<div class="empty">' +
        '<div class="empty-ico">⌕</div>' +
        '<h3>' + (state.tasks.length ? '没有匹配的任务' : '还没有任务') + '</h3>' +
        '<p>' + (state.tasks.length ? '换个筛选条件试试' : '按 N 键快速新建') + '</p>' +
        '</div>';
      return;
    }

    box.innerHTML = '<div class="list">' + items.map(function (t) {
      var tags = (t.tags || []).map(function (g) { return '<span class="tag">' + esc(g) + '</span>'; }).join('');
      var due = dueHTML(t);
      var statusText = t.status === 'doing' ? '进行中' : t.status === 'done' ? '已完成' : '待办';
      return '<div class="row' + (t.status === 'done' ? ' is-done' : '') + '" data-id="' + t.id + '">' +
        '<button class="check' + (t.status === 'done' ? ' on' : '') + '" data-toggle="' + t.id + '" title="切换完成">✓</button>' +
        '<div class="row-main" data-edit="' + t.id + '" style="cursor:pointer">' +
        '<div class="row-title">' + esc(t.title) + '</div>' +
        '<div class="row-meta">' +
        '<span>' + statusText + '</span>' +
        (t.notes ? '<span>' + esc(t.notes.slice(0, 40)) + (t.notes.length > 40 ? '…' : '') + '</span>' : '') +
        (due ? '<span>' + due + '</span>' : '') +
        (tags ? '<span style="display:inline-flex;gap:4px">' + tags + '</span>' : '') +
        '</div></div>' +
        '<span class="prio prio-' + t.priority + '">' + PRIO[t.priority].label + '</span>' +
        '<button class="row-edit" data-edit="' + t.id + '" title="编辑">✎</button>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ---------------- modal ---------------- */
  function syncSeg(sel, val) {
    $$(sel + ' button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.val === val);
    });
  }

  function openModal(id, presetStatus) {
    editingId = id || null;
    var t = id ? getTask(id) : null;

    $('#modalTitle').textContent = t ? '编辑任务' : '新建任务';
    $('#fTitle').value = t ? t.title : '';
    $('#fNotes').value = t ? (t.notes || '') : '';
    $('#fDue').value = t ? (t.due || '') : '';
    $('#fTags').value = t ? (t.tags || []).join(', ') : '';
    $('#fTitle').classList.remove('invalid');
    $('#modalDelete').hidden = !t;

    draft.status = t ? t.status : (presetStatus || 'todo');
    draft.priority = t ? t.priority : 'medium';
    syncSeg('#fStatus', draft.status);
    syncSeg('#fPriority', draft.priority);

    $('#modal').hidden = false;
    setTimeout(function () { $('#fTitle').focus(); }, 40);
  }

  function closeModal() {
    $('#modal').hidden = true;
    editingId = null;
  }

  function saveTask() {
    var titleEl = $('#fTitle');
    var title = titleEl.value.trim();
    if (!title) {
      titleEl.classList.add('invalid');
      titleEl.focus();
      return;
    }

    var tags = $('#fTags').value.split(/[,，、\s]+/).map(function (s) {
      return s.trim();
    }).filter(Boolean);
    // 去重
    tags = tags.filter(function (v, i) { return tags.indexOf(v) === i; });

    var payload = {
      title: title,
      notes: $('#fNotes').value.trim(),
      status: draft.status,
      priority: draft.priority,
      tags: tags,
      due: $('#fDue').value || '',
      updatedAt: Date.now()
    };

    if (editingId) {
      var t = getTask(editingId);
      if (t) {
        var wasDone = t.status === 'done';
        Object.keys(payload).forEach(function (k) { t[k] = payload[k]; });
        if (!wasDone && t.status === 'done') t.doneAt = Date.now();
        if (wasDone && t.status !== 'done') t.doneAt = null;
        toast('已更新');
      }
    } else {
      payload.id = uid();
      payload.createdAt = Date.now();
      payload.doneAt = payload.status === 'done' ? Date.now() : null;
      state.tasks.unshift(payload);
      toast('已创建');
    }

    save();
    closeModal();
    render();
  }

  function deleteTask(id) {
    var t = getTask(id);
    if (!t) return;
    if (!window.confirm('确定删除「' + t.title + '」？此操作不可撤销。')) return;
    state.tasks = state.tasks.filter(function (x) { return x.id !== id; });
    save();
    if (editingId === id) closeModal();
    render();
    toast('已删除');
  }

  function toggleTask(id) {
    var t = getTask(id);
    if (!t) return;
    if (t.status === 'done') {
      t.status = 'todo';
      t.doneAt = null;
    } else {
      t.status = 'done';
      t.doneAt = Date.now();
    }
    t.updatedAt = Date.now();
    save();
    render();
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1800);
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    $('#btnTheme').textContent = state.theme === 'dark' ? '☀' : '◐';
  }

  /* ---------------- import / export ---------------- */
  function exportData() {
    var blob = new Blob([JSON.stringify({
      app: 'taskboard',
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: state.tasks
    }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '任务面板备份-' + isoDate() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 JSON');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var incoming = Array.isArray(data) ? data : data.tasks;
        if (!Array.isArray(incoming)) throw new Error('格式不正确');
        var existing = {};
        state.tasks.forEach(function (t) { existing[t.id] = true; });
        var added = 0;
        incoming.forEach(function (t) {
          if (!t || !t.title) return;
          var task = {
            id: t.id && !existing[t.id] ? t.id : uid(),
            title: String(t.title),
            notes: t.notes ? String(t.notes) : '',
            status: ['todo', 'doing', 'done'].indexOf(t.status) >= 0 ? t.status : 'todo',
            priority: ['high', 'medium', 'low'].indexOf(t.priority) >= 0 ? t.priority : 'medium',
            tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
            due: typeof t.due === 'string' ? t.due : '',
            createdAt: t.createdAt || Date.now(),
            updatedAt: t.updatedAt || Date.now(),
            doneAt: t.doneAt || null
          };
          existing[task.id] = true;
          state.tasks.unshift(task);
          added++;
        });
        save();
        render();
        toast(added ? '已导入 ' + added + ' 条任务' : '没有可导入的任务');
      } catch (e) {
        toast('导入失败：不是有效的备份文件');
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- events ---------------- */
  function bind() {
    // 全局点击委托
    document.addEventListener('click', function (e) {
      var el;

      if ((el = e.target.closest('[data-add]'))) { openModal(null, el.dataset.add); return; }
      if ((el = e.target.closest('[data-del]'))) { deleteTask(el.dataset.del); return; }
      if ((el = e.target.closest('[data-toggle]'))) { toggleTask(el.dataset.toggle); return; }
      if ((el = e.target.closest('[data-edit]'))) { openModal(el.dataset.edit); return; }

      if ((el = e.target.closest('[data-view]'))) {
        state.view = el.dataset.view;
        render();
        return;
      }
      if ((el = e.target.closest('[data-mode]'))) {
        state.mode = el.dataset.mode;
        save();
        render();
        return;
      }
      if ((el = e.target.closest('[data-tag]'))) {
        var tag = el.dataset.tag;
        state.tag = state.tag === tag ? null : tag;
        render();
        return;
      }
      if ((el = e.target.closest('.chip[data-prio]'))) {
        var p = el.dataset.prio;
        state.priority = state.priority === p ? null : p;
        render();
        return;
      }
      if ((el = e.target.closest('#fStatus button'))) {
        draft.status = el.dataset.val;
        syncSeg('#fStatus', draft.status);
        return;
      }
      if ((el = e.target.closest('#fPriority button'))) {
        draft.priority = el.dataset.val;
        syncSeg('#fPriority', draft.priority);
        return;
      }
    });

    $('#btnNew').addEventListener('click', function () { openModal(null, 'todo'); });
    $('#btnClearTag').addEventListener('click', function () {
      state.tag = null;
      state.priority = null;
      render();
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });
    $('#btnTheme').addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      save();
    });

    // 搜索
    var searchEl = $('#search');
    var searchTimer = null;
    searchEl.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var v = searchEl.value;
      searchTimer = setTimeout(function () {
        state.q = v.trim();
        render();
      }, 120);
    });

    // 上传到云端
    $('#btnPush').addEventListener('click', doPush);
    $('#logClose').addEventListener('click', closeLog);
    $('#logOk').addEventListener('click', closeLog);
    $('#logModal').addEventListener('mousedown', function (e) {
      if (e.target.id === 'logModal') closeLog();
    });

    // 弹窗
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalCancel').addEventListener('click', closeModal);
    $('#modalSave').addEventListener('click', saveTask);
    $('#modalDelete').addEventListener('click', function () { if (editingId) deleteTask(editingId); });
    $('#modal').addEventListener('mousedown', function (e) {
      if (e.target.id === 'modal') closeModal();
    });
    $('#fTitle').addEventListener('input', function () {
      $('#fTitle').classList.remove('invalid');
    });

    // 看板拖拽
    var board = $('#board');

    board.addEventListener('dragstart', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
    });

    board.addEventListener('dragend', function (e) {
      var card = e.target.closest('.card');
      if (card) card.classList.remove('is-dragging');
      $$('.column', board).forEach(function (c) { c.classList.remove('is-over'); });
    });

    board.addEventListener('dragover', function (e) {
      var col = e.target.closest('.column');
      if (!col) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.column', board).forEach(function (c) {
        c.classList.toggle('is-over', c === col);
      });
    });

    board.addEventListener('dragleave', function (e) {
      var col = e.target.closest('.column');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('is-over');
    });

    board.addEventListener('drop', function (e) {
      var col = e.target.closest('.column');
      if (!col) return;
      e.preventDefault();
      var id = e.dataTransfer.getData('text/plain');
      var t = getTask(id);
      var key = col.dataset.col;
      if (t && t.status !== key) {
        t.status = key;
        t.updatedAt = Date.now();
        t.doneAt = key === 'done' ? Date.now() : null;
        save();
        render();
        var label = COLUMNS.filter(function (c) { return c.key === key; })[0].label;
        toast('已移动到「' + label + '」');
      }
      $$('.column', board).forEach(function (c) { c.classList.remove('is-over'); });
    });

    // 双击卡片快速编辑
    board.addEventListener('dblclick', function (e) {
      var card = e.target.closest('.card');
      if (card) openModal(card.dataset.id);
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var modalOpen = !$('#modal').hidden;
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

      if (e.key === 'Escape') {
        if (!$('#logModal').hidden) { closeLog(); return; }
        if (modalOpen) { closeModal(); return; }
        if (document.activeElement === searchEl && searchEl.value) {
          searchEl.value = '';
          state.q = '';
          render();
        }
        return;
      }

      if (modalOpen && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveTask();
        return;
      }

      if (typing || modalOpen) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openModal(null, 'todo');
      } else if (e.key === '/') {
        e.preventDefault();
        searchEl.focus();
      }
    });
  }

  /* ---------------- 云端上传（GitHub） ---------------- */
  var pushBusy = false;
  var pushResetTimer = null;

  function cloudAvailable() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function setPushState(mode, label) {
    var btn = $('#btnPush');
    btn.classList.remove('is-busy', 'is-ok', 'is-error', 'is-off');
    var text = { busy: '上传中…', ok: label || '已上传', error: label || '上传失败', off: '上传' };
    if (mode === 'busy') btn.classList.add('is-busy');
    if (mode === 'ok') btn.classList.add('is-ok');
    if (mode === 'error') btn.classList.add('is-error');
    if (mode === 'off') btn.classList.add('is-off');
    $('#pushLabel').textContent = text[mode] || '上传';
  }

  function flashPush(label) {
    setPushState('ok', label);
    clearTimeout(pushResetTimer);
    pushResetTimer = setTimeout(function () { setPushState('idle'); }, 2800);
  }

  function holdError() {
    setPushState('error');
    clearTimeout(pushResetTimer);
    pushResetTimer = setTimeout(function () { setPushState('idle'); }, 6000);
  }

  function statusTitle(st) {
    var bits = [];
    if (st.branch) bits.push(st.branch);
    if (st.changed) bits.push(st.changed + ' 处未提交');
    if (st.ahead) bits.push(st.ahead + ' 个提交待推送');
    if (st.lastCommit) bits.push('上次 ' + st.lastCommit.sha + ' ' + st.lastCommit.msg);
    return bits.join(' · ') || '上传到 GitHub';
  }

  async function initCloud() {
    if (!cloudAvailable()) {
      setPushState('off');
      $('#btnPush').title = '双击 start.bat 启动本地服务后可上传';
      return;
    }
    try {
      var res = await fetch('/api/status', { cache: 'no-store' });
      var st = await res.json();
      setPushState('idle');
      $('#btnPush').title = statusTitle(st);

      // 本地没有数据时，尝试用仓库里的备份恢复
      if (!hadLocalData) {
        var r2 = await fetch('/api/state', { cache: 'no-store' });
        var remote = await r2.json();
        if (remote && Array.isArray(remote.tasks) && remote.tasks.length) {
          state.tasks = remote.tasks;
          save();
          render();
          toast('已从云端备份恢复 ' + remote.tasks.length + ' 条任务');
        }
      }
    } catch (e) {
      setPushState('off');
      $('#btnPush').title = '本地服务未响应';
    }
  }

  function showLog(title, text) {
    $('#logTitle').textContent = title;
    $('#logBody').textContent = text || '（无输出）';
    $('#logModal').hidden = false;
  }

  function closeLog() {
    $('#logModal').hidden = true;
  }

  async function doPush() {
    if (pushBusy) return;
    if (!cloudAvailable()) {
      toast('请双击 start.bat 启动本地服务后再上传');
      return;
    }
    pushBusy = true;
    setPushState('busy');
    try {
      var res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: state.tasks })
      });
      var data = await res.json();

      if (res.ok && data.ok) {
        flashPush(data.upToDate ? '已是最新' : '已上传');
        toast(data.upToDate ? '远端已是最新，无需上传' : '已上传到 GitHub · ' + (data.sha || ''));
        var st = await (await fetch('/api/status', { cache: 'no-store' })).json();
        $('#btnPush').title = statusTitle(st);
      } else {
        holdError();
        showLog('上传失败', (data.error ? data.error + '\n\n' : '') + (data.log || []).join('\n'));
      }
    } catch (e) {
      holdError();
      showLog('无法连接本地服务', String((e && e.message) || e));
    } finally {
      pushBusy = false;
    }
  }

  /* ---------------- boot ---------------- */
  function boot() {
    // localhost 与 127.0.0.1 是两个不同的 origin，存储不互通。
    // 统一收敛到 127.0.0.1，避免用户换个写法就"任务全没了"。
    if (location.hostname === 'localhost') {
      location.replace('http://127.0.0.1:' + (location.port || '80') +
        location.pathname + location.search + location.hash);
      return;
    }

    load();
    applyTheme();

    var d = new Date();
    var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('#brandDate').textContent = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + week;

    bind();
    render();
    initCloud();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
