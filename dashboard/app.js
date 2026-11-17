// Token Radar dashboard: renders window.RADAR (written by main.ts into data.js)
// as a sortable, filterable board with a detail panel per protocol.
// No network, no fetch: the whole dataset is already on the page.

(function () {
  'use strict';

  var DATA = window.RADAR || { rows: [], live: [], watchlist_size: 0, board_size: 0, early_size: 0, as_of: '' };
  var WATCH = {};
  (DATA.watchlist || []).forEach(function (slug) { WATCH[slug] = true; });

  var state = { q: '', chain: '', category: '', sort: 'implied', view: 'board', slug: '' };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    stats: $('stats'), q: $('q'), chain: $('chain'), category: $('category'), sort: $('sort'),
    count: $('count'), rows: $('rows'), board: $('board'), live: $('live'), liveRows: $('live-rows'),
    empty: $('empty'), detail: $('detail'), toolbar: $('toolbar'),
    tabBoard: $('tab-board'), tabLive: $('tab-live'),
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  function moneyFull(n) {
    if (n == null || !isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function pct(n) {
    if (n == null || !isFinite(n)) return { text: '—', cls: 'flat' };
    var sign = n > 0 ? '+' : '';
    return { text: sign + n.toFixed(1) + '%', cls: n > 0 ? 'up' : n < 0 ? 'down' : 'flat' };
  }

  function ageText(days) {
    if (days == null) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    var years = days / 365;
    return years.toFixed(1) + 'y';
  }

  function chainList(chains) {
    return (chains || []).slice(0, 3).join(', ') || '—';
  }

  /* ---------------- filters, sorting, hash ---------------- */

  function readHash() {
    var out = {};
    var raw = window.location.hash.replace(/^#/, '');
    raw.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  function writeHash() {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.category) parts.push('category=' + encodeURIComponent(state.category));
    if (state.sort !== 'implied') parts.push('sort=' + encodeURIComponent(state.sort));
    if (state.view !== 'board') parts.push('view=' + encodeURIComponent(state.view));
    if (state.slug) parts.push('slug=' + encodeURIComponent(state.slug));
    var next = parts.length ? '#' + parts.join('&') : '';
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next || window.location.pathname + window.location.search);
    }
  }

  function applyHash() {
    var h = readHash();
    state.q = h.q || '';
    state.chain = h.chain || '';
    state.category = h.category || '';
    state.sort = h.sort || 'implied';
    state.view = h.view === 'live' ? 'live' : 'board';
    state.slug = h.slug || '';
    els.q.value = state.q;
    els.chain.value = state.chain;
    els.category.value = state.category;
    els.sort.value = state.sort;
  }

  var SORTS = {
    implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1); },
    tvl: function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); },
    change: function (a, b) { return (b.change_7d == null ? -Infinity : b.change_7d) - (a.change_7d == null ? -Infinity : a.change_7d); },
    age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
    name: function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; },
  };

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.chain && !(r.chains || []).includes(state.chain)) return false;
      if (state.category && r.category !== state.category) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    rows.sort(SORTS[state.sort] || SORTS.implied);
    return rows;
  }

  /* ---------------- rendering ---------------- */

  function renderStats() {
    var top = DATA.rows.length ? DATA.rows[0] : null;
    var cells = [
      ['Board rows', String(DATA.board_size)],
      ['Watchlist', String(DATA.watchlist_size)],
      ['Early finds', String(DATA.early_size)],
      ['Top implied value', top ? money(top.implied_value_usd) : '—'],
      ['Snapshot', DATA.as_of || '—'],
    ];
    els.stats.innerHTML = cells.map(function (c) {
      return '<div><dt>' + esc(c[0]) + '</dt><dd>' + esc(c[1]) + '</dd></div>';
    }).join('');
  }

  function renderOptions() {
    var chains = {};
    var cats = {};
    DATA.rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) { chains[c] = true; });
      if (r.category) cats[r.category] = true;
    });
    Object.keys(chains).sort().forEach(function (c) {
      els.chain.insertAdjacentHTML('beforeend', '<option value="' + esc(c) + '">' + esc(c) + '</option>');
    });
    Object.keys(cats).sort().forEach(function (c) {
      els.category.insertAdjacentHTML('beforeend', '<option value="' + esc(c) + '">' + esc(c) + '</option>');
    });
  }

  function rowHtml(r) {
    var change = pct(r.change_7d);
    var badge = WATCH[r.slug]
      ? ' <span class="watch">WATCHLIST</span>'
      : ' <span class="early">EARLY</span>';
    return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.slug === r.slug ? 'sel' : '') + '">' +
      '<td class="num rank">' + r.rank + '</td>' +
      '<td><span class="proto-name">' + esc(r.name) + '</span>' + badge +
        '<span class="slug">' + esc(r.slug) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + esc(chainList(r.chains)) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num ' + change.cls + '">' + change.text + '</td>' +
      '<td class="num">' + ageText(r.age_days) + '</td>' +
      '<td class="num implied">' + money(r.implied_value_usd) + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    var rows = visibleRows();
    els.rows.innerHTML = rows.map(rowHtml).join('');
    els.empty.hidden = rows.length > 0;
    els.count.textContent = rows.length + ' of ' + DATA.rows.length + ' protocols';
  }

  function renderLive() {
    els.liveRows.innerHTML = DATA.live.map(function (r) {
      var change = pct(r.change_7d);
      return '<tr>' +
        '<td><span class="proto-name">' + esc(r.name) + '</span><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(chainList(r.chains)) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td class="num ' + change.cls + '">' + change.text + '</td>' +
        '</tr>';
    }).join('');
    els.count.textContent = DATA.live.length + ' live-token protocols, by market cap';
  }

  function renderDetail() {
    var row = null;
    if (state.slug) {
      for (var i = 0; i < DATA.rows.length; i++) {
        if (DATA.rows[i].slug === state.slug) { row = DATA.rows[i]; break; }
      }
    }
    if (!row) {
      els.detail.innerHTML = '<p class="detail-hint">Click a row to see its farm plan and how its value was worked out.</p>';
      return;
    }
    var change = pct(row.change_7d);
    var steps = (row.farm_steps || []).map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');
    els.detail.innerHTML =
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">Rank #' + row.rank + ' · ' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') +
        ' · ' + esc(chainList(row.chains)) + (WATCH[row.slug] ? ' · <span class="watch">WATCHLIST</span>' : ' · <span class="early">EARLY FIND</span>') + '</p>' +
      '<dl class="facts">' +
        '<div><dt>Implied value</dt><dd>' + moneyFull(row.implied_value_usd) + '</dd></div>' +
        '<div><dt>TVL</dt><dd>' + moneyFull(row.tvl_usd) + '</dd></div>' +
        '<div><dt>7-day change</dt><dd class="' + change.cls + '">' + change.text + '</dd></div>' +
        '<div><dt>Age</dt><dd>' + (row.age_days == null ? 'Unknown' : row.age_days + ' days') + '</dd></div>' +
        '<div><dt>First tracked</dt><dd>' + esc(row.listed_at || 'Unknown') + '</dd></div>' +
        '<div><dt>Chains</dt><dd>' + esc((row.chains || []).join(', ') || '—') + '</dd></div>' +
      '</dl>' +
      '<h3>How the value is worked out</h3>' +
      '<p class="math">FDV estimate <code>' + moneyFull(row.fdv_usd) + '</code> × launch odds <code>' +
        row.launch_odds + '</code> × growth boost <code>' + row.growth_boost +
        '</code> × farmer share <code>0.12</code> = <code>' + moneyFull(row.implied_value_usd) + '</code></p>' +
      '<h3>Farm plan</h3>' +
      '<ol class="steps">' + steps + '</ol>';
  }

  function renderView() {
    var isLive = state.view === 'live';
    els.tabBoard.classList.toggle('on', !isLive);
    els.tabLive.classList.toggle('on', isLive);
    els.board.hidden = isLive;
    els.live.hidden = !isLive;
    els.toolbar.style.display = isLive ? 'none' : 'flex';
    els.detail.style.display = isLive ? 'none' : 'block';
    if (isLive) renderLive();
    else { renderBoard(); renderDetail(); }
    writeHash();
  }

  function renderAll() {
    renderStats();
    renderView();
  }

  /* ---------------- events ---------------- */

  els.q.addEventListener('input', function () { state.q = els.q.value; renderBoard(); writeHash(); });
  els.chain.addEventListener('change', function () { state.chain = els.chain.value; renderBoard(); writeHash(); });
  els.category.addEventListener('change', function () { state.category = els.category.value; renderBoard(); writeHash(); });
  els.sort.addEventListener('change', function () { state.sort = els.sort.value; renderBoard(); writeHash(); });

  els.tabBoard.addEventListener('click', function () { state.view = 'board'; renderView(); });
  els.tabLive.addEventListener('click', function () { state.view = 'live'; renderView(); });

  els.rows.addEventListener('click', function (event) {
    var tr = event.target.closest('tr[data-slug]');
    if (!tr) return;
    state.slug = tr.getAttribute('data-slug');
    renderBoard();
    renderDetail();
    writeHash();
  });

  window.addEventListener('hashchange', function () {
    applyHash();
    renderAll();
  });

  applyHash();
  renderOptions();
  renderAll();
})();
