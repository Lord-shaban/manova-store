/* MANOVA — رسوم بيانية SVG خفيفة (بدون مكتبات) وفق مواصفات dataviz:
   خط 2px، تعبئة 10%، شبكة hairline صلبة، تولتيب crosshair، قيم بأرقام مرتبة */

function niceMax(v) {
  if (v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

function compactNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

/**
 * رسم خطي زمني مع crosshair وتولتيب.
 * points: [{label, value}] — label نص عربي جاهز للعرض
 */
function lineChart(container, { points, color = '#a06e00', name = '', format = compactNum, height = 250 }) {
  container.innerHTML = '';
  container.classList.add('chart-wrap');
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  let lastW = 0;
  function draw() {
    const W = container.clientWidth;
    if (!W || W === lastW) return;
    lastW = W;
    container.querySelector('svg')?.remove();

    const H = height;
    const pad = { l: 46, r: 18, t: 14, b: 28 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    container.appendChild(svg);

    const n = points.length;
    const maxV = niceMax(Math.max(...points.map(p => p.value), 1));
    const x = i => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
    const y = v => H - pad.b - (v / maxV) * (H - pad.t - pad.b);

    // الشبكة الأفقية + تكات المحور الرأسي (خطوط صلبة hairline)
    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const v = (maxV / steps) * s;
      const yy = y(v);
      svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, stroke: '#e1e0d9', 'stroke-width': 1 }));
      const t = svgEl('text', { x: pad.l - 8, y: yy + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: '#898781', style: 'font-variant-numeric:tabular-nums' });
      t.textContent = compactNum(v);
      svg.appendChild(t);
    }

    // تسميات المحور الأفقي (متباعدة)
    const labelEvery = Math.max(1, Math.ceil(n / 6));
    points.forEach((p, i) => {
      if (i % labelEvery !== 0 && i !== n - 1) return;
      const t = svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: '#898781' });
      t.textContent = p.label;
      svg.appendChild(t);
    });

    // مساحة التعبئة (10%) + الخط (2px)
    const lineD = points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(p.value).toFixed(1)).join(' ');
    const areaD = lineD + ` L${x(n - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
    svg.appendChild(svgEl('path', { d: areaD, fill: color, opacity: 0.1 }));
    svg.appendChild(svgEl('path', { d: lineD, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // نقطة النهاية بحلقة بلون السطح
    const endDot = svgEl('circle', { cx: x(n - 1), cy: y(points[n - 1].value), r: 4.5, fill: color, stroke: '#ffffff', 'stroke-width': 2 });
    svg.appendChild(endDot);

    // طبقة الهوفر: crosshair + نقطة متحركة + تولتيب
    const cross = svgEl('line', { y1: pad.t, y2: H - pad.b, stroke: '#c3c2b7', 'stroke-width': 1, visibility: 'hidden' });
    const hoverDot = svgEl('circle', { r: 4.5, fill: color, stroke: '#ffffff', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(cross);
    svg.appendChild(hoverDot);

    const hit = svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    svg.appendChild(hit);

    function onMove(e) {
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const idx = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      const p = points[idx];
      const cx = x(idx), cy = y(p.value);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', cx); hoverDot.setAttribute('cy', cy);
      hoverDot.setAttribute('visibility', 'visible');
      tooltip.style.display = 'block';
      tooltip.innerHTML = '';
      const b = document.createElement('b'); b.textContent = format(p.value);
      const s = document.createElement('span'); s.textContent = p.label + (name ? ' · ' + name : '');
      tooltip.append(b, s);
      const tw = tooltip.offsetWidth;
      let left = cx + 12;
      if (left + tw > W - 6) left = cx - tw - 12;
      tooltip.style.left = left + 'px';
      tooltip.style.top = Math.max(4, cy - 56) + 'px';
    }
    function onLeave() {
      cross.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tooltip.style.display = 'none';
    }
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', onLeave);
  }

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  return { redraw: draw };
}

/**
 * أعمدة أفقية HTML (تنمو من اليمين في RTL) — القيمة عند طرف العمود دائمًا
 * rows: [{label, value, color?, hint?}]
 */
function hBars(container, rows, { color = '#a06e00', format = v => String(v) } = {}) {
  container.innerHTML = '';
  container.className = 'hbars';
  if (!rows.length || rows.every(r => !r.value)) {
    container.innerHTML = '<div class="empty-state" style="padding:26px">لا توجد بيانات في هذه الفترة</div>';
    return;
  }
  const max = Math.max(...rows.map(r => r.value), 1);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const label = document.createElement('div');
    label.className = 'hbar-label';
    label.textContent = r.label;
    label.title = r.label;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const bar = document.createElement('div');
    bar.className = 'hbar-bar';
    bar.style.background = r.color || color;
    bar.style.width = Math.max(2, (r.value / max) * 100) + '%';
    const val = document.createElement('span');
    val.className = 'hbar-val';
    val.textContent = format(r.value) + (r.hint ? ' ' + r.hint : '');
    track.append(bar, val);
    row.append(label, track);
    container.appendChild(row);
  }
}

/* جدول مكافئ للرسم (table view twin) */
function dataTable(headers, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.style.maxHeight = '260px';
  wrap.style.overflowY = 'auto';
  const table = document.createElement('table');
  table.className = 'data';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
  thead.appendChild(trh);
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i > 0) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

/* زر تبديل رسم/جدول داخل كارت */
function chartOrTable(toggleEl, chartHost, renderChart, getTable) {
  let mode = 'chart';
  function apply() {
    if (mode === 'chart') {
      chartHost.innerHTML = '';
      renderChart(chartHost);
    } else {
      chartHost.innerHTML = '';
      chartHost.classList.remove('chart-wrap', 'hbars');
      chartHost.appendChild(getTable());
    }
    toggleEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.m === mode));
  }
  toggleEl.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { mode = b.dataset.m; apply(); }));
  apply();
  return { rerender: apply };
}
