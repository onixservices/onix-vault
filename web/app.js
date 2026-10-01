/* Onix.Vault — the page. Reads only /v1 (same origin); the browser never holds an RPC key.
   Everything shown carries where it came from and how old it is. "—" means we never knew. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); };
  var usd2 = function (n) { return n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var short = function (a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : '—'; };
  var ago = function (ms) { if (ms == null) return ''; var s = Math.round(ms / 1000); return s < 60 ? 'read ' + s + ' s ago' : 'read ' + Math.round(s / 60) + ' min ago'; };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var get = function (path) { return fetch(path).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; }); }); };

  var VAULT = null, META = null, STATS = null, ITEMS = null, ITEMS_AT = 0;

  // ── data ──
  function loadVaults() {
    return get('/v1/vaults').then(function (b) {
      var v = b.vaults[0]; VAULT = v.vault; META = v; STATS = v.stats; return v;
    });
  }
  function loadItems(force) {
    if (ITEMS && !force && Date.now() - ITEMS_AT < 30000) return Promise.resolve(ITEMS);
    return get('/v1/vaults/' + VAULT + '/items').then(function (b) { ITEMS = b.items; ITEMS_AT = Date.now(); ITEMS.ageMs = b.itemsAgeMs; return ITEMS; });
  }
  function loadStats() { return get('/v1/vaults/' + VAULT + '/stats').then(function (s) { STATS = s; return s; }); }

  // ── board ──
  function renderBoard() {
    var st = STATS, m = META;
    $('h-name').textContent = m.name || 'Vault';
    $('h-op').textContent = 'operated by ' + (m.operator || '—');
    $('h-desc').textContent = m.description || (m.custodians || []).join(', ');
    $('h-n').textContent = st ? st.items.count : '—';
    $('h-back').textContent = st ? usd(st.backing.realisableUsd) : '—';
    if (st && st.pool) {
      $('h-mcap').textContent = usd(st.pool.mcapUsd);
      $('h-ratio').textContent = st.pool.ratio != null ? st.pool.ratio.toFixed(2) + '×' : '—';
      $('h-prog').style.width = Math.round((st.pool.graduationProgress || 0) * 100) + '%';
      $('h-grad').textContent = Math.round((st.pool.graduationProgress || 0) * 100) + '% to graduation';
      $('b-pool').textContent = 'curve: ' + st.poolStatus;
    } else {
      $('h-mcap').textContent = '—'; $('h-ratio').textContent = '—'; $('h-prog').style.width = '0%';
      $('h-grad').textContent = 'curve ' + (st ? st.poolStatus : '—');
      $('b-pool').textContent = 'curve: ' + (st ? st.poolStatus : '—');
    }
    loadItems().then(function (items) {
      $('strip').innerHTML = items.slice(0, 10).map(function (c) { return c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span></span>'; }).join('');
      $('b-live').textContent = items.length + ' items · ' + ago(items.ageMs);
    });
  }

  // ── vault page ──
  function renderVault() {
    loadStats().then(function (st) {
      $('v-eyebrow').textContent = (META.name || 'Vault') + ' · operated by ' + (META.operator || '—') + ' · wallet ' + short(VAULT);
      $('v-n').textContent = st.items.count; $('v-n2').textContent = st.items.count;
      $('v-idx').textContent = st.backing.indexUsd.toLocaleString('en-US'); $('v-mult').textContent = st.backing.multiplier;
      $('v-back').textContent = usd(st.backing.realisableUsd);
      $('v-age').textContent = ago(st.ageMs);
      $('p-wallet').textContent = VAULT;
      if (st.pool) {
        $('v-mcap').textContent = usd(st.pool.mcapUsd);
        $('v-mcap-sub').textContent = 'Price ' + usd2(st.pool.priceUsd) + ' × ' + st.pool.supply.toLocaleString('en-US') + ' supply, from the curve (' + st.poolStatus + ').';
        var r = st.pool.ratio; $('v-ratio').textContent = r != null ? r.toFixed(2) + '×' : '—';
        var pin = $('v-pin'); if (r != null) { pin.style.display = ''; pin.textContent = r.toFixed(2); pin.style.left = (28 + Math.max(-0.2, Math.min(1.2, (r - 0.87) / (1.25 - 0.87))) * 50) + '%'; }
        $('v-buy').textContent = 'Buy on the curve'; $('v-buy').href = 'https://launch.meteora.ag/?pool=' + st.pool.address;
        $('p-pool').textContent = 'Pool ' + st.pool.address + ' · mint ' + st.pool.baseMint + ' · fees so far ' + usd2(st.pool.feesLifetimeUsd) + '.';
      } else {
        $('v-mcap').textContent = '—'; $('v-mcap-sub').textContent = 'The curve has ' + st.poolStatus + '. There is no price yet, so there is no market cap: we do not make one up.';
        $('v-ratio').textContent = '—'; $('v-pin').style.display = 'none';
        $('v-buy').textContent = 'Curve not launched yet'; $('v-buy').removeAttribute('href');
        $('p-pool').textContent = 'No pool yet: ' + st.poolStatus + '.';
      }
    });
    loadItems().then(function (items) {
      $('grid').innerHTML = items.map(function (c) {
        var st = c.status === 'reserved' ? '<span class="st res">reserved</span>' : '';
        var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span class="faint" style="font-size:11px">no image</span>';
        return '<a class="item" href="#/item/' + c.mint + '"><div class="ph">' + ph + st + '</div>'
          + '<div class="tx"><span class="nm">' + esc(c.name || c.mint) + '</span><span class="gr">' + esc((c.gradingCompany || '') + ' ' + (c.grade || '')) + '</span>'
          + '<div class="pr"><b>' + usd(c.exitPriceUsd) + '</b><span>redeem ' + usd2(c.redeemPriceUsd) + '</span></div></div></a>';
      }).join('');
    });
    get('/v1/vaults/' + VAULT + '/activity').then(function (b) {
      var rows = b.activity;
      $('act-empty').style.display = rows.length ? 'none' : '';
      $('act-rows').innerHTML = rows.map(function (e) {
        var k = e.type === 'gacha' ? 'Gacha' : 'Redeemed';
        var what = e.type === 'gacha' ? 'a gacha paid ' + usd2(e.priceUsd) + ' → delivered to ' + short(e.to) : 'tokens burned → ' + (e.status === 'delivered' ? 'delivered to ' : e.status + ' · ') + short(e.to);
        var sigs = (e.paymentSignature ? '<a href="https://solscan.io/tx/' + e.paymentSignature + '" target="_blank" rel="noopener">payment</a>' : '')
          + (e.burnSignature ? '<a href="https://solscan.io/tx/' + e.burnSignature + '" target="_blank" rel="noopener">burn</a>' : '')
          + (e.deliverySignature ? ' · <a href="https://solscan.io/tx/' + e.deliverySignature + '" target="_blank" rel="noopener">delivery</a>' : ' · delivery pending');
        return '<div class="row"><span class="k">' + k + '</span><span class="muted"><a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> · ' + what + '</span><span class="sig">' + sigs + '</span></div>';
      }).join('');
    });
  }
  var tabs = document.querySelectorAll('.tabs button');
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      ['items', 'activity', 'proof'].forEach(function (t) { $('tab-' + t).style.display = t === b.dataset.tab ? '' : 'none'; });
    });
  });

  // ── item ──
  function renderItem(mint) {
    loadItems().then(function (items) {
      var c = items.filter(function (x) { return x.mint === mint; })[0];
      if (!c) { $('i-name').textContent = 'Not in the vault'; $('i-set').textContent = 'This mint is not in the vault wallet right now, or has no custodian value.'; $('i-img').removeAttribute('src'); return; }
      if (c.imageUrl) $('i-img').src = c.imageUrl; else $('i-img').removeAttribute('src');
      $('i-img').alt = c.name || '';
      $('i-crumb').textContent = c.name || short(c.mint); $('i-name').textContent = c.name || short(c.mint);
      $('i-set').textContent = [c.category, c.custodian].filter(Boolean).join(' · ');
      $('i-grade').textContent = [c.gradingCompany, c.grade].filter(Boolean).join(' ') || '—';
      $('i-cert').textContent = c.certNumber || '—'; $('i-vault').textContent = c.physicalVault || '—'; $('i-cust').textContent = c.custodian || '—';
      $('i-usd').textContent = usd2(c.custodianValueUsd); $('i-mint').textContent = c.mint;
      $('i-redeem-usd').textContent = usd2(c.redeemPriceUsd);
      $('i-redeem-tok').textContent = STATS && STATS.pool ? '≈ ' + Math.round(c.redeemPriceUsd / STATS.pool.priceUsd).toLocaleString('en-US') + ' tokens at the current price · exit × 1.15' : 'exit × 1.15 · in tokens once the curve is live';
      $('i-exit').textContent = usd2(c.exitPriceUsd);
      var res = c.status === 'reserved';
      $('i-status').textContent = res ? 'Reserved' + (c.reservedUntil ? ' · ' + Math.max(0, Math.round((c.reservedUntil - Date.now()) / 60000)) + ' min' : '') : 'Available';
      $('i-status').className = 'x ' + (res ? 'w' : 'v');
      $('i-admit').innerHTML = '<a href="https://solscan.io/token/' + c.mint + '" target="_blank" rel="noopener">token on Solscan</a>';
    });
  }

  // ── create ──
  var sel = {}, eligible = [], ineligible = [];
  function renderPick() {
    $('pick').innerHTML = eligible.map(function (c) {
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<button type="button" class="pk' + (sel[c.mint] ? ' sel' : '') + '" data-mint="' + c.mint + '">' + ph + '<div class="t"><b>' + esc(c.name) + '</b><span>' + esc([c.gradingCompany, c.grade].filter(Boolean).join(' ')) + ' · ' + usd(c.custodianValueUsd) + '</span></div></button>';
    }).join('') + ineligible.map(function (x) {
      var ph = x.imageUrl ? '<img src="' + esc(x.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<div class="pk no" aria-disabled="true"><span class="why">' + esc(x.reason) + '</span>' + ph + '<div class="t"><b>' + esc(x.name) + '</b><span>not eligible</span></div></div>';
    }).join('');
    var n = 0, i = 0; eligible.forEach(function (c) { if (sel[c.mint]) { n++; i += c.custodianValueUsd; } });
    var h = STATS ? STATS.backing.multiplier : 0.89, adm = STATS && STATS.band ? STATS.band.admission : 0.8;
    var r = i * h, g = r * adm;
    $('c-sel').textContent = n; $('c-idx').textContent = usd(i); $('c-real').textContent = usd(r); $('c-get').textContent = usd(g);
    $('r-sel').textContent = n; $('r-real').textContent = usd(r); $('r-get').textContent = usd(g); $('r-grad').textContent = usd(r * 3);
  }
  function scan(addr) {
    $('c-summary').textContent = 'Reading ' + short(addr) + ' from the chain…';
    sel = {}; eligible = []; ineligible = []; renderPick();
    get('/v1/wallets/' + encodeURIComponent(addr) + '/eligible-items').then(function (b) {
      eligible = b.eligible; ineligible = b.ineligible;
      $('c-summary').textContent = b.total + ' tokens in ' + short(addr) + ' · ' + eligible.length + ' eligible · ' + ineligible.length + ' not (each says why)';
      eligible.slice(0, 3).forEach(function (c) { sel[c.mint] = true; });
      renderPick();
    }).catch(function (e) { $('c-summary').textContent = 'Could not read that wallet: ' + e.message; });
  }
  $('pick').addEventListener('click', function (e) {
    var b = e.target.closest('button.pk'); if (!b) return;
    sel[b.dataset.mint] = !sel[b.dataset.mint]; renderPick();
  });
  $('c-scan').addEventListener('click', function () { var a = $('c-addr').value.trim(); if (a) scan(a); });
  $('c-addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var a = $('c-addr').value.trim(); if (a) scan(a); } });
  $('c-connect').addEventListener('click', function () {
    var w = window.solana || (window.phantom && window.phantom.solana);
    if (!w || !w.connect) { $('c-summary').textContent = 'No Solana wallet found in this browser — paste an address instead.'; return; }
    w.connect().then(function (r) { var a = (r && r.publicKey ? r.publicKey : w.publicKey).toString(); $('c-addr').value = a; scan(a); })
      .catch(function () { $('c-summary').textContent = 'Wallet connection was declined.'; });
  });
  function step(n) {
    [1, 2, 3].forEach(function (k) { $('c' + k).style.display = k === n ? '' : 'none'; var s = $('st' + k); s.className = 'step' + (k === n ? ' on' : k < n ? ' done' : ''); });
    window.scrollTo({ top: 0 });
  }
  $('to2').addEventListener('click', function () { step(2); });
  $('to3').addEventListener('click', function () { step(3); });
  $('back1').addEventListener('click', function () { step(1); });
  $('back2').addEventListener('click', function () { step(2); });
  renderPick();

  // ── How it works: the simulation panel (an example vault; the real one is above) ──
  (function () {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { try { $('fly').pauseAnimations(); } catch (e) {} }
    var ICON = {
      watch: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="6"/><path d="M9 7V3h6v4M9 19v2h6v-2M12 10v3l2 1"/></svg>',
      wine: '<svg viewBox="0 0 24 24"><path d="M9 2h6v5l3 4v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V11l3-4z"/><path d="M6 15h12"/></svg>',
      card: '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><rect x="8" y="5" width="8" height="7" rx="1"/><path d="M8 16h8M8 19h5"/></svg>',
      comic: '<svg viewBox="0 0 24 24"><path d="M4 3h14a2 2 0 0 1 2 2v16H4z"/><path d="M4 3v18M8 8h8M8 12h8M8 16h5"/></svg>',
      ring: '<svg viewBox="0 0 24 24"><circle cx="12" cy="15" r="6"/><path d="M8 7l4-5 4 5M8 7h8"/></svg>',
      user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/></svg>',
      game: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M8 10v5M5.5 12.5h5M16 11h.01M18.5 13.5h.01"/></svg>',
      trade: '<svg viewBox="0 0 24 24"><path d="M4 9h13l-3-3M20 15H7l3 3"/></svg>',
      fire: '<svg viewBox="0 0 24 24"><path d="M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-3-1-6-4-8 0 4-4 6-4 11 0 4 3 8 7 8z"/></svg>',
      cart: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2 12h11l2-8H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/></svg>'
    };
    var ITEMS_X = [
      { n: 'Rolex Submariner 2019', k: 'watch', v: 9800 }, { n: 'Charizard PSA 10', k: 'card', v: 3100 }, { n: 'Macallan 25', k: 'wine', v: 2400 },
      { n: 'Amazing Fantasy #15 CGC 3.0', k: 'comic', v: 21000 }, { n: 'Black Lotus MTG BGS 8', k: 'card', v: 14500 }, { n: 'Omega Speedmaster', k: 'watch', v: 4200 },
      { n: 'Blastoise Base Set PSA 9', k: 'card', v: 1900 }, { n: 'Petrus 2005', k: 'wine', v: 5600 }, { n: 'Cartier Love ring', k: 'ring', v: 1700 },
      { n: 'One Piece Luffy OP01 PSA 10', k: 'card', v: 640 }, { n: 'Tudor Black Bay 58', k: 'watch', v: 3300 }, { n: 'Batman #1 CGC 2.5', k: 'comic', v: 8900 }
    ];
    var who = function () { var a = '3f9ak2e7c1bd58'.split(''); var p = function () { return a[Math.floor(Math.random() * a.length)]; }; return p() + p() + '…' + p() + p(); };
    var S = { usd: 0, items: [], fees: 0, sold: 0, cash: 0 };
    var shelf = $('t-shelf'), feed = $('t-feed');
    if (!shelf) return;
    function paint(delta) {
      $('t-usd').textContent = usd(S.usd); $('t-items').textContent = S.items.length; $('t-fees').textContent = usd(S.fees); $('t-sold').textContent = usd(S.sold);
      if (delta) { var d = $('t-delta'); d.textContent = (delta > 0 ? '+' : '−') + usd(Math.abs(delta)); d.classList.add('on'); setTimeout(function () { d.classList.remove('on'); }, 1400); }
    }
    function drawShelf() { shelf.innerHTML = S.items.slice(-8).map(function (it) { return '<div class="it" title="' + esc(it.n) + '">' + ICON[it.k] + '<span class="pr">' + usd(it.v) + '</span></div>'; }).join(''); }
    function push(icon, html, amt, sub, red) {
      var row = document.createElement('div'); row.className = 'ev' + (red ? ' red' : '');
      row.innerHTML = ICON[icon] + '<span>' + html + '</span><span class="amt">' + amt + (sub ? '<small>' + sub + '</small>' : '') + '</span>';
      feed.insertBefore(row, feed.firstChild);
      while (feed.children.length > 7) feed.removeChild(feed.lastChild);
    }
    var pool = ITEMS_X.slice();
    function take() { if (!pool.length) pool = ITEMS_X.slice(); return pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; }
    var steps = [
      function () { var it = take(); S.items.push(it); S.usd += it.v; push('user', '<span class="who">' + who() + '</span> <span class="what">put in</span> <span class="item">' + esc(it.n) + '</span>', '+' + usd(it.v), 'got tokens for 80% of realisable, locked 12 m'); paint(it.v); drawShelf(); },
      function () { var t = [40, 120, 260, 75, 900, 310][Math.floor(Math.random() * 6)]; var fee = t * 0.10; S.fees += fee; S.cash += fee * 0.5; S.usd += fee * 0.5; push('trade', '<span class="who">' + who() + '</span> <span class="what">traded</span> ' + usd(t) + ' <span class="who">of the token</span>', '+' + usd(fee * 0.5), 'fee → the vault'); paint(fee * 0.5); },
      function () { if (S.items.length < 2) return steps[0](); var i = Math.floor(Math.random() * S.items.length); var it = S.items.splice(i, 1)[0]; var app = ['Pixel Gacha', 'Slab Arena', 'Cellar Club', 'Vault Royale'][Math.floor(Math.random() * 4)]; S.sold += it.v; S.cash += it.v; push('game', '<span class="who">' + app + '</span> <span class="what">bought</span> <span class="item">' + esc(it.n) + '</span> <span class="who">for a player</span>', usd(it.v), 'paid in USDC · listed price'); paint(0); drawShelf(); },
      function () { if (S.cash < 400) return steps[1](); var it = take(); var spend = Math.min(S.cash, it.v); it = { n: it.n, k: it.k, v: spend }; S.items.push(it); S.cash -= spend; push('cart', '<span class="what">The vault bought</span> <span class="item">' + esc(it.n) + '</span> <span class="who">with the money inside</span>', '+1 item', usd(spend) + ' → an item'); paint(0); drawShelf(); },
      function () { if (S.items.length < 3) return steps[1](); var i = Math.floor(Math.random() * S.items.length); var it = S.items.splice(i, 1)[0]; var prem = it.v * 0.15; S.usd -= it.v; S.usd += prem; push('fire', '<span class="who">' + who() + '</span> <span class="what">took out</span> <span class="item">' + esc(it.n) + '</span> <span class="who">· burned tokens</span>', '−' + usd(it.v), '+' + usd(prem) + ' premium stays', true); paint(-it.v + prem); drawShelf(); }
    ];
    var order = [0, 1, 0, 1, 1, 2, 3, 1, 0, 1, 4, 1, 2, 1, 3, 0, 1, 1, 2, 3, 1, 4, 0, 1], k = 0;
    function next() { steps[order[k % order.length]](); k++; }
    next(); next(); next(); paint(0);
    if (!reduced) setInterval(next, 2400);
  })();

  // ── router ──
  function route() {
    var h = location.hash || '#/', m, id = 'home';
    if (h.indexOf('#/app') === 0) id = 'home';
    else if (h.indexOf('#/vault') === 0) { id = 'vault'; renderVault(); }
    else if ((m = h.match(/^#\/item\/(.+)$/))) { id = 'item'; renderItem(m[1]); }
    else if (h.indexOf('#/create') === 0) { id = 'create'; step(1); }
    else if (h.indexOf('#/integrate') === 0) id = 'integrate';
    else if (h.indexOf('#/how') === 0) id = 'how';
    if (id === 'home') renderBoard();
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) { s.classList.toggle('on', s.id === 's-' + id); });
    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) { a.classList.toggle('on', a.dataset.nav === id || ((id === 'vault' || id === 'item') && a.dataset.nav === 'home')); });
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);
  loadVaults().then(route).catch(function (e) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', '<p class="note warn" style="margin-top:24px"><b>The vault API is not answering.</b> ' + esc(e.message) + '</p>');
  });
})();
