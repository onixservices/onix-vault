/* Onix.Vault — the page. Reads only /v1 (same origin); the browser never holds an RPC key.
   Everything shown carries where it came from and how old it is. "—" means we never knew. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); };
  var usd2 = function (n) { return n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var price = function (n) { if (n == null) return '—'; if (n >= 0.01) return usd2(n); var d = Math.min(12, 2 - Math.floor(Math.log10(n)) + 2); return '$' + n.toFixed(d).replace(/0+$/, ''); };
  var short = function (a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : '—'; };
  var ago = function (ms) { if (ms == null) return ''; var s = Math.round(ms / 1000); return s < 60 ? 'read ' + s + ' s ago' : 'read ' + Math.round(s / 60) + ' min ago'; };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var get = function (path) { return fetch(path).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; }); }); };

  var VAULTS = [], VAULT = null, META = null, STATS = null, ITEMS = null, ITEMS_AT = 0;
  var SYM = function () { return '$' + ((META && META.token && META.token.symbol) || 'VEONIX'); };
  var vpath = function (suffix) { return '#/vault/' + (META && META.id ? META.id : '1') + (suffix || ''); };

  // ── data ──
  function loadVaults() {
    return get('/v1/vaults').then(function (b) { VAULTS = b.vaults; if (!META && VAULTS.length) selectVault(VAULTS[0].id); return VAULTS; });
  }
  function selectVault(id) {
    var v = VAULTS.filter(function (x) { return String(x.id) === String(id) || x.vault === id; })[0] || VAULTS[0];
    if (!v) return null;
    if (VAULT !== v.vault) { ITEMS = null; ITEMS_AT = 0; }
    VAULT = v.vault; META = v; STATS = v.stats; return v;
  }
  function loadItems(force) {
    if (ITEMS && !force && Date.now() - ITEMS_AT < 30000) return Promise.resolve(ITEMS);
    return get('/v1/vaults/' + VAULT + '/items').then(function (b) { ITEMS = b.items; ITEMS_AT = Date.now(); ITEMS.ageMs = b.itemsAgeMs; return ITEMS; });
  }
  function loadStats(fresh) { return get('/v1/vaults/' + VAULT + '/stats' + (fresh ? '?fresh=1' : '')).then(function (s) { STATS = s; return s; }); }
  // after a trade: re-read the chain (cache bypassed) until the market cap moves, then redraw
  function refreshAfterTrade() {
    var before = STATS && STATS.pool ? STATS.pool.mcapUsd : null, tries = 0;
    (function tick() {
      tries++;
      loadStats(true).then(function (st) {
        var moved = !st.pool || before == null || Math.abs(st.pool.mcapUsd - before) > 1e-9;
        if (moved || tries >= 8) { tradePanel(st); renderVault(); loadBalances(); } else setTimeout(tick, 2500);
      }).catch(function () { if (tries < 8) setTimeout(tick, 2500); });
    })();
  }

  // ── board: Live (graduated) on top, Maturing (on the curve) below, Create last ──
  var STRIPS = {};
  function fanHtml(items, n, cls) { return (items || []).slice(0, n).map(function (c, i) { return c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy" style="--rot:' + ((i - (n - 1) / 2) * 7) + 'deg">' : ''; }).join(''); }
  function isLive(v) { return !!(v.stats && v.stats.pool && v.stats.poolStatus === 'migrated'); }
  function tile(v) {
    var st = v.stats, p = st && st.pool, sym = '$' + ((v.token && v.token.symbol) || 'TOKEN'), live = isLive(v);
    var pct = p ? Math.round((p.graduationProgress || 0) * 100) : 0, need = p && p.graduationUsdc, raised = p ? p.raisedUsd || 0 : 0;
    var kv = live
      ? '<div class="kv"><span>Price</span><b>' + price(p.priceUsd) + '</b><span>Backing</span><b>' + usd(st.backing.realisableUsd) + '</b><span>Market cap</span><b>' + usd(p.mcapUsd) + '</b><span>Items</span><b>' + st.items.count + '</b></div>'
      : p ? '<div class="kv"><span>Raised</span><b>' + usd2(raised) + ' <span class="faint">of ' + (need ? usd(need) : '—') + '</span></b><span>Backing</span><b>' + usd(st.backing.realisableUsd) + '</b></div><div class="prog"><i style="width:' + pct + '%"></i></div>'
      : '<div class="kv"><span>Backing</span><b>' + (st ? usd(st.backing.realisableUsd) : '—') + '</b><span>Items</span><b>' + (st ? st.items.count : '—') + '</b></div>';
    var foot = live ? '<span>trade · play</span><span class="tag live">Live</span>' : p ? '<span>' + pct + '% to graduation · buy on the curve</span><span class="tag mat">Maturing</span>' : '<span>' + esc(st ? st.poolStatus : '—') + '</span><span class="tag">' + esc(st ? st.poolStatus : '—') + '</span>';
    var banner = v.token && v.token.banner ? ' style="background-image:url(' + esc(v.token.banner) + ')"' : '';
    return '<a class="tile" href="#/vault/' + v.id + '"><div class="ban"' + banner + '><div class="coin"><img src="' + esc((v.token && v.token.image) || '/token/default.png') + '" alt=""></div><div class="fan" data-strip="' + v.vault + '"></div></div><div class="body"><div class="name"><b>' + esc(v.name) + '</b><span>' + esc(sym) + '</span></div>' + kv + '<div class="foot">' + foot + '</div></div></a>';
  }
  function renderBoard() {
    var live = VAULTS.filter(isLive), mat = VAULTS.filter(function (v) { return !isLive(v); });
    var createTile = '<a class="tile create" href="#/create"><div class="plus">+</div><b>Create a vault</b><span style="font-size:13px">Put in items a custodian already tokenized. You get half the supply and 40% of every trade.</span></a>';
    $('shelf-live').style.display = live.length ? '' : 'none';
    $('board-live').innerHTML = live.map(tile).join('');
    $('board-mat').innerHTML = mat.map(tile).join('') + createTile;
    VAULTS.forEach(function (v) {
      var paint = function (items) { var el = document.querySelector('[data-strip="' + v.vault + '"]'); if (el) el.innerHTML = fanHtml(items.slice().reverse(), 4); };
      if (STRIPS[v.vault]) paint(STRIPS[v.vault]);
      else get('/v1/vaults/' + v.vault + '/items').then(function (b) { STRIPS[v.vault] = b.items; paint(b.items); }).catch(function () {});
    });
  }
  // ── vault page: the vault's own mini-site (hero · stats · tabs) ──
  var ITEM_FILTER = 'all', EXPLAIN_LONG = false;   // the long explainer boxes live in How it works; the Trade tab keeps one line
  function mine() { return !!(W.addr && META.creator && W.addr === META.creator); }
  function renderVault() {
    var tk = META.token || {};
    $('v-crumb').textContent = META.name || 'Vault'; $('tk-name').textContent = META.name || tk.name || 'Vault'; $('tk-sym').textContent = '$' + (tk.symbol || '—'); $('tk-img').src = tk.image || '/token/default.png';
    $('vh-ban').style.backgroundImage = tk.banner ? 'url(' + tk.banner + ')' : '';
    $('vh-desc').textContent = META.description || '';
    $('v-eyebrow').textContent = 'created by ' + (META.operator || '—') + ' · custody ' + short(VAULT) + (META.rulesText ? ' · ' + META.rulesText : '');
    $('v-send').href = vpath('/send'); $('v-send').style.display = mine() ? '' : 'none';
    $('p-wallet').textContent = VAULT; $('p-creator').textContent = META.creator || '—'; $('p-fee').textContent = (META.creatorFeePct || 40) + '%'; $('p-rules').textContent = META.rulesText || '—';
    loadStats().then(function (st) {
      if (T.wallet && st.pool && (BAL.wallet !== T.wallet || BAL.usdc == null)) loadBalances();
      var p = st.pool, live = p && st.poolStatus === 'migrated', b = st.backing;
      $('vh-chip').textContent = live ? 'Live' : p ? 'Maturing' : st.poolStatus; $('vh-chip').className = 'tag ' + (live ? 'live' : p ? 'mat' : '');
      $('vh-play').textContent = live ? 'Play' : 'Buy on the curve'; $('vh-play').dataset.go = live ? 'play' : 'trade'; $('vh-trade').style.display = live ? '' : 'none';
      var S = function (k, v, s) { return '<div><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + (s || '') + '</div></div>'; };
      var backing = S('Backing', usd(b.realisableUsd), st.items.count + ' item' + (st.items.count === 1 ? '' : 's') + ' · ' + usd(b.indexUsd) + ' insured × ' + b.multiplier + ' · ' + ago(st.ageMs));
      var html;
      if (!p) html = backing + S('Token', '—', st.poolStatus);
      else if (live) {
        var lk = p.locked, cre = lk ? (lk.creatorPct != null ? Math.round(p.supply * lk.creatorPct / 100) : lk.tokens) : null;
        html = S('Price', price(p.priceUsd), 'Meteora pool' + (p.damm ? ' · <a href="https://app.meteora.ag/dammv2/' + esc(p.damm.address) + '" target="_blank" rel="noopener">' + short(p.damm.address) + '</a>' : ''))
          + backing
          + S('Market cap', usd(p.mcapUsd) + (p.ratio != null ? '<small>' + p.ratio.toFixed(2) + '× backing</small>' : ''), 'price × ' + p.supply.toLocaleString('en-US'))
          + S('Fees so far', usd2(p.feesLifetimeUsd), 'on the curve · 1% on the pool')
          + (cre != null ? S((mine() ? 'Your' : 'Creator') + ' share', Math.round(cre / 1e6 * 100) / 100 + 'M<small>locked</small>', (lk.locker ? '<a href="' + esc(lk.locker.url) + '" target="_blank" rel="noopener">' + esc(lk.locker.program) + '</a> · ' + (lk.vestingMonths || 6) + ' months' : 'releases over ' + (lk.vestingMonths || 6) + ' months') + (mine() && lk.locker ? ' · <a href="' + esc(lk.locker.url) + '" target="_blank" rel="noopener"><b>claim</b></a>' : '')) : '');
      } else {
        var gq = p.graduationUsdc, raised = p.raisedUsd || 0;
        html = S('Raised', usd2(raised) + (gq ? '<small>of ' + usd(gq) + '</small>' : ''), 'USDC on the curve')
          + backing
          + S('Price', price(p.priceUsd), 'on the curve · fee 10%')
          + S('Market cap', usd(p.mcapUsd) + (p.ratio != null ? '<small>' + p.ratio.toFixed(2) + '× backing</small>' : ''), p.openingMcapUsd ? 'opened at ' + usd(p.openingMcapUsd) : '')
          + S('Graduates at', usd(META.graduationUsd || (p.openingMcapUsd ? p.openingMcapUsd * (META.gradMult || 2.5) : null)), 'market cap · ' + (META.gradMult || 2.5) + '× the opening');
        var pr = Math.round((p.graduationProgress || 0) * 100);
        $('m-pct').textContent = pr + '%'; $('m-prog').style.width = pr + '%'; $('m-left').textContent = gq ? usd2(Math.max(0, gq - raised)) : '—';
      }
      $('vh-stats').innerHTML = html;
      $('vh-mature').style.display = p && !live ? '' : 'none';
      var pin = $('v-pin'), r = p ? p.ratio : null;
      if (r != null) { pin.style.display = ''; pin.textContent = r.toFixed(2); pin.style.left = (28 + Math.max(-0.2, Math.min(1.2, (r - 0.87) / (1.25 - 0.87))) * 50) + '%'; } else pin.style.display = 'none';
      $('p-pool').textContent = p ? 'Curve ' + p.address + ' · mint ' + p.baseMint + (p.damm ? ' · pool ' + p.damm.address : '') + '.' : 'No pool yet: ' + st.poolStatus + '.';
      $('tab-play-btn').classList.toggle('lock', !live); $('tab-play-n').textContent = live ? '' : 'locked';
      tradePanel(st); renderExplain(st);
    });
    loadItems().then(function (items) {
      $('vh-fan').innerHTML = fanHtml(items.slice().reverse(), 5);
      $('tab-items-n').textContent = items.length || '';
      renderItems(items);
    });
    get('/v1/vaults/' + VAULT + '/activity').then(function (b) {
      var rows = b.activity;
      $('act-empty').style.display = rows.length ? 'none' : '';
      $('act-rows').innerHTML = rows.map(function (e) {
        if (e.type === 'admit') { return '<div class="row"><span class="k">Added</span><span class="muted"><a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> · by the creator · ' + usd2(e.valueUsd) + ' listed' + (e.status === 'pending' ? ' · verifying on chain' : ' · in the vault') + '</span><span class="sig"><a href="https://solscan.io/tx/' + e.signature + '" target="_blank" rel="noopener">transfer</a></span></div>'; }
        if (e.type === 'play') { return '<div class="row"><span class="k">Play</span><span class="muted">' + short(e.to) + ' paid ' + (e.unit === 'token' ? Math.round(e.price).toLocaleString('en-US') + ' ' + SYM() + ' (burned)' : usd2(e.price) + ' USDC') + ' · ' + (e.mint ? '<a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> ' : '') + (e.status === 'delivered' ? 'delivered' : e.status.replace(/_/g, ' ')) + '</span><span class="sig">' + (e.paymentSignature ? '<a href="https://solscan.io/tx/' + e.paymentSignature + '" target="_blank" rel="noopener">payment</a>' : '') + (e.deliverySignature ? ' · <a href="https://solscan.io/tx/' + e.deliverySignature + '" target="_blank" rel="noopener">delivery</a>' : '') + '</span></div>'; }
        var k = e.type === 'gacha' ? 'Gacha' : 'Redeemed';
        var what = e.type === 'gacha' ? 'a gacha paid ' + usd2(e.priceUsd) + ' → delivered to ' + short(e.to) : 'tokens burned → ' + (e.status === 'delivered' ? 'delivered to ' : e.status + ' · ') + short(e.to);
        var sigs = (e.paymentSignature ? '<a href="https://solscan.io/tx/' + e.paymentSignature + '" target="_blank" rel="noopener">payment</a>' : '')
          + (e.burnSignature ? '<a href="https://solscan.io/tx/' + e.burnSignature + '" target="_blank" rel="noopener">burn</a>' : '')
          + (e.deliverySignature ? ' · <a href="https://solscan.io/tx/' + e.deliverySignature + '" target="_blank" rel="noopener">delivery</a>' : ' · delivery pending');
        return '<div class="row"><span class="k">' + k + '</span><span class="muted"><a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> · ' + what + '</span><span class="sig">' + sigs + '</span></div>';
      }).join('');
    });
  }
  var BANDS_DEF = [{ id: 'b1', label: 'under $25', min: 0, max: 25 }, { id: 'b2', label: '$25 – $60', min: 25, max: 60 }, { id: 'b3', label: '$60 – $150', min: 60, max: 150 }, { id: 'b4', label: '$150 and up', min: 150, max: Infinity }];
  function bandOf(v) { for (var i = 0; i < BANDS_DEF.length; i++) if (v >= BANDS_DEF[i].min && v < BANDS_DEF[i].max) return BANDS_DEF[i].id; return 'b4'; }
  function renderItems(items) {
    var counts = {}; items.forEach(function (c) { var b = bandOf(c.custodianValueUsd || 0); counts[b] = (counts[b] || 0) + 1; });
    $('item-filters').innerHTML = '<button type="button" data-f="all" class="' + (ITEM_FILTER === 'all' ? 'on' : '') + '">All ' + items.length + '</button>' + BANDS_DEF.filter(function (b) { return counts[b.id]; }).map(function (b) { return '<button type="button" data-f="' + b.id + '" class="' + (ITEM_FILTER === b.id ? 'on' : '') + '">' + b.label + ' · ' + counts[b.id] + '</button>'; }).join('');
    var shown = ITEM_FILTER === 'all' ? items : items.filter(function (c) { return bandOf(c.custodianValueUsd || 0) === ITEM_FILTER; });
    $('grid').innerHTML = shown.slice().sort(function (a, b) { return (b.custodianValueUsd || 0) - (a.custodianValueUsd || 0); }).map(function (c) {
      var st = c.status === 'reserved' ? '<span class="st res">reserved</span>' : '';
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span class="faint" style="font-size:11px">no image</span>';
      return '<a class="item" href="#/item/' + c.mint + '"><div class="ph">' + ph + st + '</div>'
        + '<div class="tx"><span class="nm">' + esc(c.name || c.mint) + '</span><span class="gr">' + esc((c.gradingCompany || '') + ' ' + (c.grade || '')) + '</span>'
        + '<div class="pr"><b>' + usd(c.custodianValueUsd) + '</b><span>insured</span></div></div></a>';
    }).join('') || '<p class="faint">Nothing in custody right now.</p>';
  }
  $('item-filters').addEventListener('click', function (e) { var b = e.target.closest('button[data-f]'); if (!b) return; ITEM_FILTER = b.dataset.f; if (ITEMS) renderItems(ITEMS); });
  function renderExplain(st) {
    var p = st.pool, live = p && st.poolStatus === 'migrated', b = st.backing, fee = META.creatorFeePct || 40;
    if (!EXPLAIN_LONG) {
      var lk0 = p && p.locked;
      $('t-explain').innerHTML = '<div class="box"><p>One token = one of ' + (p ? p.supply.toLocaleString('en-US') : '10,000,000') + ' shares of what is in custody (<b>' + usd(b.realisableUsd) + '</b> today). '
        + (live ? 'Trades go to this vault\'s Meteora pool; ' + (lk0 ? Math.round((lk0.creatorPct != null ? p.supply * lk0.creatorPct / 100 : lk0.tokens) / 1e6 * 100) / 100 + 'M are the creator\'s, in <a href="' + esc(lk0.locker ? lk0.locker.url : 'https://lock.jup.ag') + '" target="_blank" rel="noopener">Jupiter Lock</a>. ' : '')
                : 'On the curve the 10% fee pays the creator (' + (fee * 0.08).toFixed(1) + '%) and this vault\'s treasury; at graduation 30% of the USDC goes to the vault and Play opens. ')
        + '<a href="#/how">How it works →</a></p></div>';
      return;
    }
    var boxes = ['<div class="box"><h3>What a token is</h3><p>One of ' + (p ? p.supply.toLocaleString('en-US') : '10,000,000') + ' shares of what sits in the custody wallet. Backing today: <b>' + usd(b.realisableUsd) + '</b> = ' + usd(b.indexUsd) + ' insured × ' + b.multiplier + ' realisable. Market cap is price × supply and is shown separately. They are never added.</p></div>'];
    if (live) {
      var lk = p.locked;
      boxes.push('<div class="box"><h3>Where each trade goes</h3><p>The pool charges 1% per trade; it goes to the pool\'s locked liquidity. On the curve, 10% went: 2% Meteora · ' + (fee * 0.08).toFixed(1) + '% creator · the rest to this vault\'s treasury and Onix.</p></div>');
      boxes.push('<div class="box"><h3>Creator unlock</h3><p>' + (lk ? Math.round((lk.creatorPct != null ? p.supply * lk.creatorPct / 100 : lk.tokens) / 1e6 * 100) / 100 + 'M ' + SYM() + ' are in Jupiter Lock, releasing monthly over ' + (lk.vestingMonths || 6) + ' months from graduation.' : 'The creator\'s share is in Jupiter Lock.') + '</p><div class="links">' + (lk && lk.locker ? '<a href="' + esc(lk.locker.url) + '" target="_blank" rel="noopener">Jupiter Lock ↗</a><a href="https://solscan.io/account/' + esc(lk.locker.escrow) + '" target="_blank" rel="noopener">escrow ↗</a>' : '') + (p.damm ? '<a href="https://app.meteora.ag/dammv2/' + esc(p.damm.address) + '" target="_blank" rel="noopener">Pool on Meteora ↗</a>' : '') + '<a href="https://solscan.io/token/' + esc(p.baseMint) + '" target="_blank" rel="noopener">Mint on Solscan ↗</a></div></div>');
    } else if (p) {
      boxes.push('<div class="box"><h3>Where each trade goes</h3><p>Fee 10% per trade: 2% Meteora · ' + (fee * 0.08).toFixed(1) + '% creator (on chain, from the first trade) · the rest to this vault\'s treasury and Onix. The treasury buys the next item. The first 60 seconds after opening charge 99%→10% to keep bots out.</p></div>');
      boxes.push('<div class="box"><h3>At graduation</h3><p>The USDC raised moves to a Meteora pool with the token (locked for good), 30% of it goes to this vault\'s treasury, the creator\'s 50% start a 6-month unlock, and Play opens.</p><div class="links"><a href="https://solscan.io/account/' + esc(p.address) + '" target="_blank" rel="noopener">Curve on Solscan ↗</a><a href="https://solscan.io/token/' + esc(p.baseMint) + '" target="_blank" rel="noopener">Mint ↗</a></div></div>');
    }
    $('t-explain').innerHTML = boxes.join('');
  }
  // ── the trade panel: quote on the API, sign & send in the wallet (never here) ──
  var T = { side: 'buy', wallet: null, timer: null, busy: false };
  function provider() { return window.solana || (window.phantom && window.phantom.solana) || null; }
  // ── the wallet: connected once, in the header; every door reads the same address ──
  var W = { addr: null };
  function setWallet(a) {
    W.addr = a; T.wallet = a; SD.wallet = a;
    $('w-connect').textContent = a ? short(a) : 'Connect wallet';
    $('w-connect').classList.toggle('on', !!a);
    if (a) { $('sd-addr').value = a; }
    if ($('s-create').classList.contains('on')) { if (a) { scan(a); checkResume(); } else { CQ = null; $('c-summary').textContent = 'Connect your wallet (top right) to see what it can open a vault on.'; renderPick(); } }
    if (STATS) tradePanel(STATS);
    loadBalances();
    if (a && $('s-send').classList.contains('on')) sdScan(a); else sdRender();
  }
  function connectWallet(opts) {
    var w = provider();
    if (!w || !w.connect) { if (!opts || !opts.silent) alert('No Solana wallet found in this browser.'); return Promise.reject(new Error('no wallet')); }
    return w.connect(opts && opts.silent ? { onlyIfTrusted: true } : undefined)
      .then(function (r) { setWallet((r && r.publicKey ? r.publicKey : w.publicKey).toString()); return W.addr; });
  }
  $('w-connect').addEventListener('click', function () {
    if (W.addr) { var w = provider(); if (w && w.disconnect) w.disconnect().catch(function () {}); setWallet(null); return; }
    connectWallet().catch(function () {});
  });
  (function () { var w = provider(); if (w && w.on) { w.on('disconnect', function () { setWallet(null); }); w.on('accountChanged', function (pk) { setWallet(pk ? pk.toString() : null); }); } })();
  window.addEventListener('load', function () { connectWallet({ silent: true }).catch(function () {}); });
  // The wallet signs AND sends (it simulates and applies its own protections that way). web3.js
  // is vendored at /vendor/solana-web3.min.js so the page can hand it a Transaction object —
  // the `request({ message })` form was refused by current Phantom builds ("version 24").
  function signAndSend(w, txB64) {
    var raw = Uint8Array.from(atob(txB64), function (ch) { return ch.charCodeAt(0); });
    var tx = window.solanaWeb3.Transaction.from(raw);
    return w.signAndSendTransaction(tx).then(function (r) { return r && r.signature ? r.signature : String(r); });
  }
  var BAL = { usdc: null, token: null, wallet: null };
  function loadBalances() {
    if (!T.wallet || !(STATS && STATS.pool)) { BAL = { usdc: null, token: null, wallet: null }; paintBalance(); return Promise.resolve(); }
    var w = T.wallet;
    return get('/v1/vaults/' + VAULT + '/trades/balances?wallet=' + encodeURIComponent(w)).then(function (b) { if (w === T.wallet) { BAL = { usdc: b.usdc, token: b.token, wallet: w }; paintBalance(); } }).catch(function () {});
  }
  function heldNow() { return T.side === 'buy' ? BAL.usdc : BAL.token; }
  function paintBalance() {
    var h = heldNow();
    $('t-bal').textContent = !T.wallet ? 'Connect a wallet to see your balance' : h == null ? 'Reading your balance…' : 'You have ' + (T.side === 'buy' ? '$' + h.toFixed(2) + ' USDC' : Math.floor(h).toLocaleString('en-US') + ' ' + SYM());
    $('t-max').hidden = !(h > 0);
  }
  $('t-max').addEventListener('click', function () { var h = heldNow(); if (h > 0) { $('t-amount').value = T.side === 'buy' ? Math.floor(h * 100) / 100 : Math.floor(h); quoteNow(); } });
  function tradePanel(st) {
    var p = st && st.pool, el = $('trade');
    paintBalance();
    var migrated = p && st.poolStatus === 'migrated';
    el.classList.toggle('off', !p);
    el.classList.toggle('graduated', !!migrated);
    $('t-state').textContent = p ? (migrated ? 'on the pool' : 'on the curve') : 'not launched';
    $('t-state').className = 'tag' + (p ? ' live' : '');
    $('t-grad').innerHTML = '';
    $('t-venue').textContent = !p ? '' : migrated
      ? 'The swap is built against this vault\'s Meteora pool and signed in your wallet; the page never leaves. Jupiter becomes a second route once the pool is listed there.'
      : 'Buys fill up to the graduation threshold and return the rest. Signed in your wallet; the server never holds your keys.';
    $('t-go').textContent = p ? (T.wallet ? (T.side === 'buy' ? 'Buy ' : 'Sell ') + SYM() : 'Connect wallet') : 'Opens when the token launches';
    $('t-unit').textContent = T.side === 'buy' ? 'USDC' : SYM();
  }
  function quoteNow() {
    var v = parseFloat($('t-amount').value);
    if (!(v > 0) || !(STATS && STATS.pool)) { $('t-quote').textContent = 'You receive —'; return; }
    $('t-quote').textContent = 'Quoting…';
    fetch('/v1/vaults/' + VAULT + '/trades/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: T.side, amount: v }) })
      .then(function (r) { return r.json(); })
      .then(function (q) {
        if (q.error) {
          var h = heldNow();
          if (/insufficient liquidity/i.test(q.error)) {
            var p = STATS && STATS.pool, room = p && p.graduationUsdc ? Math.max(0, p.graduationUsdc - (p.raisedUsd || 0)) : null;
            if (T.side === 'buy' && room != null) $('t-quote').textContent = 'The curve only takes ' + usd2(room) + ' more before it graduates — try ' + usd2(Math.ceil(room / 0.9 * 100) / 100) + ' (fee included).';
            else $('t-quote').textContent = 'That is more than the curve holds.' + (h != null ? ' You have ' + (T.side === 'buy' ? '$' + h.toFixed(2) + ' USDC' : Math.floor(h).toLocaleString('en-US') + ' ' + SYM()) + ' — use Max.' : '');
          }
          else $('t-quote').textContent = q.error;
          return;
        }
        $('t-quote').textContent = (q.partial ? 'The curve takes ' + usd2(q.amountInUsed) + ' of this and graduates; ' + usd2(q.amountInLeft) + ' stays with you. ' : '') + 'You receive ≈ ' + (T.side === 'buy' ? Math.round(q.amountOut).toLocaleString('en-US') + ' ' + SYM() : usd2(q.amountOut)) + ' · fee ' + usd2((q.tradingFeeUsd || 0) + (q.protocolFeeUsd || 0)) + (q.priceImpactPct != null ? ' · impact ' + q.priceImpactPct.toFixed(1) + '%' : '') + ' · min ' + (T.side === 'buy' ? Math.round(q.minimumAmountOut).toLocaleString('en-US') : usd2(q.minimumAmountOut)) + ' (1% slippage)';
      }).catch(function (e) { $('t-quote').textContent = 'Could not quote: ' + e.message; });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs2 button'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tabs2 button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on'); T.side = b.dataset.side; tradePanel(STATS); quoteNow(); if (BAL.wallet !== T.wallet) loadBalances();
    });
  });
  $('t-amount').addEventListener('input', function () { clearTimeout(T.timer); T.timer = setTimeout(quoteNow, 350); });
  $('t-go').addEventListener('click', function () {
    if (!(STATS && STATS.pool) || T.busy) return;
    var w = provider();
    if (!w || !w.connect) { $('t-msg').textContent = 'No Solana wallet found in this browser.'; return; }
    if (!T.wallet) { connectWallet().catch(function () { $('t-msg').textContent = 'Wallet connection was declined.'; }); return; }
    var v = parseFloat($('t-amount').value);
    if (!(v > 0)) { $('t-msg').textContent = 'Enter an amount.'; return; }
    T.busy = true; $('t-go').textContent = 'Building…'; $('t-msg').textContent = '';
    fetch('/v1/vaults/' + VAULT + '/trades/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: T.wallet, side: T.side, amount: v }) })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (b.error) throw new Error(b.error);
        $('t-go').textContent = 'Confirm in your wallet…';
        return signAndSend(w, b.transaction);
      })
      .then(function (sig) {
        $('t-msg').innerHTML = 'Sent · <a href="https://solscan.io/tx/' + sig + '" target="_blank" rel="noopener">' + sig.slice(0, 8) + '…</a>';
        $('t-amount').value = ''; $('t-quote').textContent = 'You receive —';
        setTimeout(refreshAfterTrade, 2500);
      })
      .catch(function (e) { $('t-msg').textContent = e && e.message ? e.message : 'Cancelled.'; })
      .then(function () { T.busy = false; tradePanel(STATS); });
  });

  var tabs = document.querySelectorAll('.vtabs button');
  function showTab(name) {
    Array.prototype.forEach.call(tabs, function (x) { x.classList.toggle('on', x.dataset.tab === name); });
    ['trade', 'play', 'items', 'activity', 'proof'].forEach(function (t) { $('tab-' + t).style.display = t === name ? '' : 'none'; });
    if (name === 'play') renderPlay();
    if (name === 'trade' && STATS) { tradePanel(STATS); if (BAL.wallet !== T.wallet) loadBalances(); }
  }
  Array.prototype.forEach.call(tabs, function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
  $('vh-acts').addEventListener('click', function (e) { var b = e.target.closest('button[data-go]'); if (!b) return; showTab(b.dataset.go); var el = $('tab-' + b.dataset.go); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  // ── play: one machine per band that has items; the reason a button is off is written before the click ──
  var PL = { busy: false, bands: null };
  function fanBig(preview) { var n = Math.min(preview.length, 7), s = preview.slice(0, n); return s.map(function (c, i) { var k = i - (n - 1) / 2; return c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy" style="--x:' + (k * 34) + 'px;--rot:' + (k * 9) + 'deg;z-index:' + (10 - Math.abs(k)) + '">' : ''; }).join(''); }
  function renderPlay() {
    $('bands').innerHTML = '<p class="faint">Reading the vault…</p>';
    var pBands = get('/v1/vaults/' + VAULT + '/play'), pBal = (W.addr && STATS && STATS.pool) ? get('/v1/vaults/' + VAULT + '/trades/balances?wallet=' + encodeURIComponent(W.addr)).catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([pBands, pBal]).then(function (r) {
      var b = r[0], bal = r[1]; PL.bands = b;
      if (bal) BAL = { usdc: bal.usdc, token: bal.token, wallet: W.addr };
      var withItems = b.bands.filter(function (x) { return x.kind !== 'empty'; });
      if (!b.open) {
        $('play-h').textContent = 'Play opens at graduation';
        $('bands').innerHTML = '<div class="locked"><div class="lk">🔒</div><h3>' + esc(b.lockedReason || 'Play is not open yet') + '</h3><p>' + (STATS && STATS.pool && STATS.pool.graduationUsdc ? usd2(Math.max(0, STATS.pool.graduationUsdc - (STATS.pool.raisedUsd || 0))) + ' more USDC on the curve and the items below become machines. ' : '') + 'Until then the vault only grows: nothing leaves custody.</p>' + (withItems.length ? '<div class="ghosts">' + withItems.map(function (x) { return '<span>' + esc(x.label) + ' · ' + x.items + ' item' + (x.items === 1 ? '' : 's') + '</span>'; }).join('') + '</div>' : '') + '</div>';
        return;
      }
      $('play-h').textContent = 'Pick a machine';
      if (!withItems.length) { $('bands').innerHTML = '<div class="locked"><h3>Nothing to draw right now</h3><p>The vault has no free items in custody. The treasury buys the next one; the creator can add more.</p></div>'; return; }
      $('bands').innerHTML = withItems.map(function (x) {
        var n = x.items, hold = BAL.token, cash = BAL.usdc;
        var canUsd = !!W.addr && cash != null && cash >= x.priceUsdc, canTok = !!W.addr && x.priceTokens != null && hold != null && hold >= x.priceTokens;
        var usdcWhy = !W.addr ? 'Connect wallet to play' : cash == null ? 'Reading your balance…' : !canUsd ? 'You have ' + usd2(cash) + ' USDC' : '';
        var tokWhy = !W.addr ? 'Connect wallet to play' : x.priceTokens == null ? 'Token plays open when the token trades' : hold == null ? 'Reading your balance…' : !canTok ? 'You hold ' + Math.floor(hold).toLocaleString('en-US') + ' ' + SYM() : '';
        var top = Math.max.apply(null, x.preview.map(function (c) { return c.custodianValueUsd || 0; }));
        return '<div class="machine ' + x.kind + '" data-band="' + x.id + '"><div class="mh"><b>' + esc(x.label) + '</b><span>' + n + ' item' + (n === 1 ? '' : 's') + (x.kind === 'pick' ? ' · pick, not a draw' : '') + '</span></div>'
          + '<div class="fanbig">' + fanBig(x.preview) + '</div>'
          + '<div class="odds"><span><b>1 in ' + n + '</b> each</span><span>avg value <b>' + usd(x.avgIndexUsd) + '</b></span>' + (x.preview.length === n ? '<span>top <b>' + usd(top) + '</b></span>' : '') + '</div>'
          + '<div class="pay"><button type="button" class="usdc" data-band="' + x.id + '" data-cur="usdc"' + (canUsd ? '' : ' disabled') + '><b>' + usd2(x.priceUsdc) + '</b><span>USDC · stays in the vault</span>' + (usdcWhy ? '<small>' + esc(usdcWhy) + '</small>' : '') + '</button>'
          + '<button type="button" data-band="' + x.id + '" data-cur="token"' + (canTok ? '' : ' disabled') + '><b>' + (x.priceTokens != null ? x.priceTokens.toLocaleString('en-US') + ' ' + SYM() : '—') + '</b><span>burned · ' + usd(x.avgIndexUsd * 1.10) + ' of backing</span>' + (tokWhy ? '<small>' + esc(tokWhy) + '</small>' : '') + '</button></div></div>';
      }).join('');
    }).catch(function (e) { $('bands').innerHTML = '<p class="faint">Play is not open on this vault: ' + esc(e.message) + '</p>'; });
  }
  // the reveal overlay: four steps, the card flips, the proof folded under "Verify the draw"
  function revealFrame(step, items, p, won) {
    var steps = ['Commit published before you pay' + (p && p.serverSeedHash ? ' <span class="mono faint">' + esc(p.serverSeedHash.slice(0, 12)) + '…</span>' : ''), 'Payment signed' + (p && p.paymentSignature ? ' · <a href="https://solscan.io/tx/' + p.paymentSignature + '" target="_blank" rel="noopener">' + short(p.paymentSignature) + '</a>' : ''), 'Finalized on chain · drawing from ' + items + ' item' + (items === 1 ? '' : 's'), 'Sent to your wallet from custody'];
    var done = step >= 4;
    $('veil').style.display = '';
    $('reveal').innerHTML = '<div class="steps">' + steps.map(function (t, i) { return '<div class="' + (i < step ? 'done' : i === step ? 'now' : '') + '"><i>' + (i < step ? '✓' : i + 1) + '</i><span>' + t + '</span></div>'; }).join('') + '</div>'
      + '<div class="stage">' + (won && won.img ? '<img src="' + esc(won.img) + '" alt="">' : '<div class="back' + (step === 0 ? ' still' : '') + '">?</div>') + '</div>'
      + (won ? '<div class="won"><b>' + esc(won.title) + '</b><span>' + won.sub + '</span></div>' : '')
      + (won && won.proof ? '<details><summary>Verify the draw</summary><div class="proof">' + won.proof + '</div></details>' : '')
      + '<div class="ra">' + (done ? (p && p.deliverySignature ? '<a class="cta ghost sm" href="https://solscan.io/tx/' + p.deliverySignature + '" target="_blank" rel="noopener">Delivery on Solscan ↗</a>' : '') + '<button type="button" class="cta sm" id="rv-close">Done</button>' : '<button type="button" class="cta ghost sm" id="rv-close">' + (step === 0 ? 'Cancel' : 'Hide') + '</button>') + '</div>';
    $('rv-close').onclick = function () { $('veil').style.display = 'none'; };
  }
  $('bands').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-band]'); if (!b || b.disabled || PL.busy) return;
    var w = provider(); if (!w) { alert('No Solana wallet found in this browser.'); return; }
    if (!W.addr) { connectWallet().catch(function () {}); return; }
    var band = b.dataset.band, cur = b.dataset.cur, clientSeed = Math.random().toString(36).slice(2, 10), m = b.closest('.machine');
    var items = (PL.bands && PL.bands.bands.filter(function (x) { return x.id === band; })[0] || {}).items || 0;
    PL.busy = true; revealFrame(0, items, null, null);
    var playId = null, P = null;
    post('/v1/vaults/' + VAULT + '/plays', { band: band, player: W.addr, currency: cur, clientSeed: clientSeed })
      .then(function (x) {
        if (x.status !== 201) throw new Error(x.body.error || 'could not open the play');
        playId = x.body.playId; P = { serverSeedHash: x.body.serverSeedHash }; items = x.body.items;
        revealFrame(1, items, P, null);
        return signAndSend(w, x.body.paymentTransaction);
      })
      .then(function (sig) {
        P.paymentSignature = sig; revealFrame(2, items, P, null); m.classList.add('drawing');
        return post('/v1/vaults/' + VAULT + '/plays/' + playId + '/submit', { signature: sig });
      })
      .then(function () {
        var tries = 0;
        return (function poll() {
          tries++;
          return get('/v1/vaults/' + VAULT + '/plays/' + playId).then(function (p) {
            if (p.status === 'drawn' || p.status === 'delivering') revealFrame(3, items, p, null);
            if (['delivered', 'delivery_failed', 'payment_rejected', 'payment_missing'].indexOf(p.status) >= 0 || tries > 80) return p;
            return new Promise(function (r) { setTimeout(r, 3000); }).then(poll);
          });
        })();
      })
      .then(function (p) {
        m.classList.remove('drawing');
        return loadItems(true).then(function (list) {
          var it = (STRIPS[VAULT] || []).concat(list || []).filter(function (c) { return c.mint === p.mint; })[0] || {};
          var proof = '<span>commit (before you paid): sha256 = ' + esc(p.serverSeedHash) + '</span>' + (p.serverSeed ? '<span>server seed (revealed): ' + esc(p.serverSeed) + '</span>' : '') + '<span>your seed: ' + esc(p.clientSeed) + ' · nonce ' + p.nonce + '</span>' + (p.digest ? '<span>digest = HMAC(seed, play|yourSeed|nonce) = ' + esc(p.digest) + ' → index ' + p.index + ' of ' + p.snapshot.length + ' (sorted by mint)</span>' : '') + '<span>' + (p.paymentSignature ? '<a href="https://solscan.io/tx/' + p.paymentSignature + '" target="_blank" rel="noopener">payment</a>' : '') + (p.deliverySignature ? ' · <a href="https://solscan.io/tx/' + p.deliverySignature + '" target="_blank" rel="noopener">delivery</a>' : '') + '</span>';
          var won = p.status === 'delivered' ? { img: it.imageUrl, title: it.name || short(p.mint), sub: esc([it.gradingCompany, it.grade].filter(Boolean).join(' ')) + (it.custodianValueUsd ? ' · insured ' + usd(it.custodianValueUsd) : '') + ' · now in your wallet', proof: proof }
            : p.status === 'delivery_failed' ? { img: it.imageUrl, title: 'Drawn: ' + (it.name || short(p.mint)), sub: 'delivery is being retried by the operator; your payment is recorded', proof: proof }
            : { img: null, title: p.status.replace(/_/g, ' '), sub: esc(p.failReason || ''), proof: proof };
          revealFrame(p.status === 'delivered' ? 4 : 3, items, p, won);
          STRIPS[VAULT] = null; renderPlay(); loadStats(true).then(function (st) { STATS = st; renderVault(); });
        });
      })
      .catch(function (e) { m.classList.remove('drawing'); revealFrame(0, items, P, { img: null, title: 'Not played', sub: esc((e && e.message) || String(e)), proof: null }); })
      .then(function () { PL.busy = false; });
  });

  // ── item ──
  function renderItem(mint) {
    loadItems().then(function (items) {
      var c = items.filter(function (x) { return x.mint === mint; })[0];
      if (!c && VAULTS.length > 1) {
        return Promise.all(VAULTS.map(function (v) { return get('/v1/vaults/' + v.vault + '/items').then(function (b) { return { v: v, hit: b.items.filter(function (x) { return x.mint === mint; })[0] }; }); }))
          .then(function (rs) { var r = rs.filter(function (x) { return x.hit; })[0]; if (r) { selectVault(r.v.id); ITEMS = null; return renderItem(mint); } return renderItemFound(null, mint); });
      }
      return renderItemFound(c, mint);
    });
  }
  function renderItemFound(c, mint) {
    {
      if (!c) { $('i-name').textContent = 'Not in the vault'; $('i-set').textContent = 'This mint is not in the vault wallet right now, or has no custodian value.'; $('i-img').removeAttribute('src'); return; }
      if (c.imageUrl) $('i-img').src = c.imageUrl; else $('i-img').removeAttribute('src');
      $('i-img').alt = c.name || '';
      $('i-crumb').textContent = c.name || short(c.mint); $('i-name').textContent = c.name || short(c.mint);
      $('i-set').textContent = [c.category, c.custodian].filter(Boolean).join(' · ');
      $('i-grade').textContent = [c.gradingCompany, c.grade].filter(Boolean).join(' ') || '—';
      $('i-cert').textContent = c.certNumber || '—'; $('i-vault').textContent = c.physicalVault || '—'; $('i-cust').textContent = c.custodian || '—';
      $('i-usd').textContent = usd2(c.custodianValueUsd); $('i-mint').textContent = c.mint;
      var bd = BANDS_DEF.filter(function (b) { return b.id === bandOf(c.custodianValueUsd || 0); })[0];
      $('i-play').innerHTML = '<a href="' + vpath('/play') + '">' + esc(bd ? bd.label : 'its band') + '</a>';
      $('i-play-sub').textContent = STATS && STATS.pool && STATS.poolStatus === 'migrated' ? 'open the machine \u2192' : 'Play opens when the vault graduates';
      $('i-exit').textContent = usd2(c.exitPriceUsd);
      var res = c.status === 'reserved';
      $('i-status').textContent = res ? 'Reserved' + (c.reservedUntil ? ' · ' + Math.max(0, Math.round((c.reservedUntil - Date.now()) / 60000)) + ' min' : '') : 'Available';
      $('i-status').className = 'x ' + (res ? 'w' : 'v');
      $('i-admit').innerHTML = '<a href="https://solscan.io/token/' + c.mint + '" target="_blank" rel="noopener">token on Solscan</a>';
      $('i-crumb-vault').textContent = META.name || 'Vault'; $('i-crumb-vault').href = vpath(); $('i-buy').href = vpath();
    }
  }

  // ── create: items → token + rules → launch (deposits to custody, then the launch) ──
  var CQ = null, CR = { busy: false, creationId: null }, CSEL = {}, CQ_PICK = { n: 0 };
  function rulesFromForm() { return { category: $('f-cat').value, minValueUsd: Number($('f-minv').value), minGrade: $('f-grade').value === 'any' ? 'any' : Number($('f-grade').value), creatorFeePct: Number($('f-fee').value), gradMult: Number($('f-grad').value) }; }
  function renderPick() {
    var q = CQ;
    $('pick').innerHTML = !q ? '' : q.items.map(function (c) {
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<button type="button" class="pk' + (CSEL[c.mint] ? ' sel' : '') + '" data-mint="' + c.mint + '">' + ph + '<div class="t"><b>' + esc(c.name) + '</b><span>' + usd(c.custodianValueUsd) + '</span></div></button>';
    }).join('') + (q ? q.ineligible.map(function (x) {
      var ph = x.imageUrl ? '<img src="' + esc(x.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<div class="pk no" aria-disabled="true"><span class="why">' + esc(x.reason) + '</span>' + ph + '<div class="t"><b>' + esc(x.name) + '</b><span>not eligible</span></div></div>';
    }).join('') : '');
    $('c-calc').style.display = q ? '' : 'none';
    var n = 0, idx = 0; if (q) q.items.forEach(function (c) { if (CSEL[c.mint]) { n++; idx += c.custodianValueUsd; } });
    var real = Math.round(idx * 0.89 * 100) / 100, gm = Number($('f-grad').value) || 2.5;
    CQ_PICK = { n: n, indexUsd: idx, realisableUsd: real, openingMcapUsd: Math.round(real * 2 * 100) / 100, graduationUsd: Math.round(real * 2 * gm * 100) / 100 };
    if (q) { $('c-sel').textContent = n; $('c-idx').textContent = usd(idx); $('c-real').textContent = usd(real); $('c-get').textContent = usd(real); }
    $('to2').disabled = !(q && n > 0 && real >= 5);
  }
  function scan(addr) {
    $('c-summary').textContent = 'Reading ' + short(addr) + ' from the chain…'; CQ = null; renderPick();
    get('/v1/vaults/create/quote?wallet=' + encodeURIComponent(addr) + '&rules=' + encodeURIComponent(JSON.stringify(rulesFromForm()))).then(function (q) {
      CQ = q; CSEL = {}; q.items.forEach(function (c) { CSEL[c.mint] = true; });
      $('c-summary').textContent = q.canCreate ? q.items.length + ' item' + (q.items.length === 1 ? '' : 's') + ' in ' + short(addr) + ' can back a vault' : 'Nothing in ' + short(addr) + ' can back a vault yet — ' + q.why;
      renderPick();
    }).catch(function (e) { $('c-summary').textContent = 'Could not read that wallet: ' + e.message; });
  }
  function step(n) {
    [1, 2, 3].forEach(function (k) { $('c' + k).style.display = k === n ? '' : 'none'; var s = $('st' + k); s.className = 'step' + (k === n ? ' on' : k < n ? ' done' : ''); });
    window.scrollTo({ top: 0 });
  }
  function review() {
    var name = $('f-name').value.trim(), sym = $('f-sym').value.trim().toUpperCase();
    if (!name || !/^[A-Z0-9]{2,10}$/.test(sym)) { $('c2-msg').textContent = 'A name (up to 32 characters) and a symbol of 2–10 letters or digits.'; return false; }
    var x = $('f-x').value.trim(); if (x && !/^https:\/\//.test(x)) { $('c2-msg').textContent = 'The X link must start with https://'; return false; }
    $('c2-msg').textContent = '';
    renderPick();
    var r = rulesFromForm();
    $('r-name').textContent = name; $('r-sym').textContent = '$' + sym; $('r-real').textContent = usd(CQ_PICK.realisableUsd); $('r-sel').textContent = CQ_PICK.n + ' item' + (CQ_PICK.n === 1 ? '' : 's');
    $('r-open').textContent = usd(CQ_PICK.openingMcapUsd); $('r-grad').textContent = usd(CQ_PICK.graduationUsd); $('r-get').textContent = usd(CQ_PICK.realisableUsd);
    $('r-rules').textContent = 'Takes ' + ({ mixed: 'any graded card', pokemon: 'Pokémon cards', 'one-piece': 'One Piece cards', sports: 'sports cards' }[r.category]) + (r.minGrade !== 'any' ? ' graded ' + r.minGrade + '+' : '') + (r.minValueUsd ? ' worth $' + r.minValueUsd + '+' : '') + ' from Collector Crypt · your fee share ' + r.creatorFeePct + '% · graduates at ' + r.gradMult + '× the opening cap.';
    return true;
  }
  $('pick').addEventListener('click', function (e) { var b = e.target.closest('button.pk'); if (!b) return; CSEL[b.dataset.mint] = !CSEL[b.dataset.mint]; renderPick(); });
  ['f-cat', 'f-minv', 'f-grade'].forEach(function (id) { $(id).addEventListener('change', function () { if (W.addr) scan(W.addr); }); });
  $('f-grad').addEventListener('change', renderPick);
  $('to2').addEventListener('click', function () { if (CQ && CQ_PICK.n > 0) step(2); });
  $('to3').addEventListener('click', function () { if (review()) step(3); });
  $('back1').addEventListener('click', function () { step(1); });
  $('back2').addEventListener('click', function () { step(2); });
  $('f-sym').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  function post(path, body) { return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); }); }
  function cmsg(t, pct) { $('c-msg').textContent = t; if (pct != null) { $('c-prog').style.display = ''; $('c-prog-i').style.width = pct + '%'; } }
  function remember(id) { try { if (id) localStorage.setItem('onix.vault.creation', id); else localStorage.removeItem('onix.vault.creation'); } catch (e) {} }
  function remembered() { try { return localStorage.getItem('onix.vault.creation'); } catch (e) { return null; } }

  // the launch, from a creation that is at least "opened"
  function launchFrom(creationId, depositTxs) {
    var w = provider();
    CR.busy = true; $('c-launch').disabled = true;
    var p = Promise.resolve();
    (depositTxs || []).forEach(function (b64, i) {
      p = p.then(function () { cmsg('Sign deposit ' + (i + 1) + ' of ' + depositTxs.length + ' in your wallet (your items + gas → the vault\'s custody)…', 10 + 30 * i / depositTxs.length); return signAndSend(w, b64); });
    });
    return p.then(function () {
      cmsg('Waiting for the chain to show the items in custody, then setting up the curve (Onix pays this part)…', 45);
      var tries = 0;
      return (function dep() { tries++; return post('/v1/vaults/create/deposited', { creationId: creationId }).then(function (x) { if (x.status === 200) return x.body; if (x.status === 409 && tries < 24) return new Promise(function (r) { setTimeout(r, 5000); }).then(dep); throw new Error(x.body.error || 'could not confirm the deposit'); }); })();
    }).then(function (d) {
      cmsg('Sign the launch in your wallet…', 70);
      var raw = Uint8Array.from(atob(d.transaction), function (ch) { return ch.charCodeAt(0); });
      return w.signTransaction(window.solanaWeb3.Transaction.from(raw));
    }).then(function (signed) {
      cmsg('Sending the launch…', 80);
      var bytes = signed.serialize({ requireAllSignatures: false, verifySignatures: false });
      var b64 = btoa(Array.prototype.map.call(bytes, function (x) { return String.fromCharCode(x); }).join(''));
      return post('/v1/vaults/create/submit', { creationId: creationId, signedTransaction: b64 }).then(function (s) { if (s.status !== 200) throw new Error(s.body.error || 'could not send the launch'); return s.body.signature; });
    }).then(function (sig) {
      cmsg('Launched: ' + short(sig) + ' · confirming on chain…', 90);
      var tries = 0;
      return (function conf() { tries++; return post('/v1/vaults/create/confirm', { creationId: creationId, signature: sig }).then(function (x) { if (x.status === 201) return x.body.vault; if (x.status === 409 && tries < 20) return new Promise(function (r) { setTimeout(r, 3000); }).then(conf); throw new Error(x.body.error || 'could not confirm'); }); })();
    }).then(function (v) {
      cmsg('Your vault is live.', 100); remember(null);
      return loadVaults().then(function () { location.hash = '#/vault/' + v.id; });
    }).catch(function (e) { cmsg((e && e.message) || String(e)); })
      .then(function () { CR.busy = false; $('c-launch').disabled = false; });
  }
  var UP = { image: null, banner: null };
  // the picture is cropped and resized in the browser before it goes up: the coin to a 512 square, the banner
  // to 3:1 at 1200×400 — whatever the file was (a 6 MB photo included), what leaves is small and the right shape
  var SHAPES = { image: { w: 512, h: 512 }, banner: { w: 1200, h: 400 } };
  function fitImage(file, shape) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var sw = img.naturalWidth, sh = img.naturalHeight, target = shape.w / shape.h, cw = sw, ch = sh;
        if (sw / sh > target) cw = Math.round(sh * target); else ch = Math.round(sw / target);   // centre crop to the shape
        var c = document.createElement('canvas'); c.width = Math.min(shape.w, cw); c.height = Math.round(c.width / target);
        c.getContext('2d').drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
        var png = file.type === 'image/png' && file.size < 400 * 1024;   // keep small PNGs (transparency); photos become JPEG
        c.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('could not read that image')); }, png ? 'image/png' : 'image/jpeg', 0.9);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('that file is not an image the browser can read')); };
      img.src = url;
    });
  }
  function wireUpload(kind) {
    $('f-' + kind).addEventListener('change', function () {
      var f = this.files && this.files[0]; if (!f) return;
      var msg = $('up-' + kind + '-msg'), pv = $('pv-' + kind), input = this;
      // a new pick replaces the old one entirely: id and preview go first, so a failure never keeps the previous image
      UP[kind] = null; pv.style.backgroundImage = ''; pv.textContent = kind === 'image' ? '$' : '';
      msg.textContent = 'fitting ' + (kind === 'image' ? 'to a square' : 'to 3:1') + '…';
      fitImage(f, SHAPES[kind])
        .then(function (blob) { msg.textContent = 'uploading ' + Math.round(blob.size / 1024) + ' KB…'; return blob.arrayBuffer().then(function (buf) { return fetch('/v1/vaults/create/upload', { method: 'POST', headers: { 'content-type': blob.type }, body: buf }); }); })
        .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.status); return b; }); })
        .then(function (b) { UP[kind] = b.uploadId; msg.textContent = Math.round(b.bytes / 1024) + ' KB · ' + b.type.replace('image/', '') + ' · ' + SHAPES[kind].w + '×' + SHAPES[kind].h; pv.style.backgroundImage = 'url(' + b.url + ')'; pv.textContent = ''; })
        .catch(function (e) { UP[kind] = null; msg.textContent = e.message; })
        .then(function () { input.value = ''; });   // so picking the same file again fires `change`
    });
  }
  wireUpload('image'); wireUpload('banner');
  $('c-launch').addEventListener('click', function () {
    if (CR.busy || !CQ || !W.addr) return;
    var w = provider(); if (!w) { cmsg('No Solana wallet found in this browser.'); return; }
    var name = $('f-name').value.trim(), sym = $('f-sym').value.trim().toUpperCase();
    var body = { owner: W.addr, name: name, symbol: sym, mints: Object.keys(CSEL).filter(function (m) { return CSEL[m]; }), rules: rulesFromForm(), description: $('f-desc').value.trim() || null, links: $('f-x').value.trim() ? { x: $('f-x').value.trim() } : {}, imageId: UP.image || null, bannerId: UP.banner || null };
    CR.busy = true; $('c-launch').disabled = true; cmsg('Opening the vault (custody wallet)…', 5);
    post('/v1/vaults/create/open', body).then(function (x) {
      if (x.status !== 201) throw new Error(x.body.error || 'could not open');
      CR.creationId = x.body.creationId; remember(CR.creationId); CR.busy = false;
      return launchFrom(x.body.creationId, x.body.depositTransactions);
    }).catch(function (e) { cmsg((e && e.message) || String(e)); CR.busy = false; $('c-launch').disabled = false; });
  });
  // a creation left half-way (page closed, wallet declined): continue or take the items back
  function checkResume() {
    var id = remembered(); $('c-resume').style.display = 'none'; if (!id || !W.addr) return;
    get('/v1/vaults/create/' + id).then(function (s) {
      if (s.status === 'launched' || s.status === 'abandoned') { remember(null); return; }
      $('c-resume-sym').textContent = '$' + s.symbol + ' · ' + s.status; $('c-resume').style.display = '';
      $('c-resume-go').onclick = function () { step(3); $('r-name').textContent = s.name; $('r-sym').textContent = '$' + s.symbol; $('r-sel').textContent = s.mints.length + ' item' + (s.mints.length === 1 ? '' : 's'); if (s.backingUsd) { $('r-real').textContent = usd(s.backingUsd); $('r-get').textContent = usd(s.backingUsd); $('r-open').textContent = usd(s.backingUsd * 2); } if (s.graduationUsd) $('r-grad').textContent = usd(s.graduationUsd); launchFrom(id, s.depositTransactions || null); };
      $('c-resume-abandon').onclick = function () { $('c-resume-abandon').disabled = true; post('/v1/vaults/create/abandon', { creationId: id, owner: W.addr }).then(function (x) { remember(null); $('c-resume').style.display = 'none'; alert(x.status === 200 ? 'Your items are on their way back (' + x.body.returned.length + ' transfer(s)).' : (x.body.error || 'could not abandon')); }); };
    }).catch(function () {});
  }
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
      function () { var it = take(); S.items.push(it); S.usd += it.v; push('user', '<span class="who">the creator</span> <span class="what">put in</span> <span class="item">' + esc(it.n) + '</span>', '+' + usd(it.v), 'no new tokens \u00b7 backing per token up'); paint(it.v); drawShelf(); },
      function () { var t = [40, 120, 260, 75, 900, 310][Math.floor(Math.random() * 6)]; var fee = t * 0.10; S.fees += fee; S.cash += fee * 0.32; S.usd += fee * 0.32; push('trade', '<span class="who">' + who() + '</span> <span class="what">traded</span> ' + usd(t) + ' <span class="who">of the token</span>', '+' + usd(fee * 0.32), 'fee: 3.2% creator \u00b7 3.2% the vault \u00b7 2% Meteora'); paint(fee * 0.32); },
      function () { if (S.items.length < 2) return steps[0](); var i = Math.floor(Math.random() * S.items.length); var it = S.items.splice(i, 1)[0]; var app = ['Pixel Gacha', 'Slab Arena', 'Cellar Club', 'Vault Royale'][Math.floor(Math.random() * 4)]; S.sold += it.v; S.cash += it.v; push('game', '<span class="who">' + app + '</span> <span class="what">bought</span> <span class="item">' + esc(it.n) + '</span> <span class="who">for a player</span>', usd(it.v), 'paid in USDC through the API \u00b7 money stays'); paint(0); drawShelf(); },
      function () { if (S.cash < 400) return steps[1](); var it = take(); var spend = Math.min(S.cash, it.v); it = { n: it.n, k: it.k, v: spend }; S.items.push(it); S.cash -= spend; push('cart', '<span class="what">The vault bought</span> <span class="item">' + esc(it.n) + '</span> <span class="who">with the money inside</span>', '+1 item', usd(spend) + ' → an item'); paint(0); drawShelf(); },
      function () { if (S.items.length < 3) return steps[1](); var i = Math.floor(Math.random() * S.items.length); var it = S.items.splice(i, 1)[0]; S.usd -= it.v; push('fire', '<span class="who">' + who() + '</span> <span class="what">played</span> <span class="who">and drew</span> <span class="item">' + esc(it.n) + '</span> <span class="who">\u00b7 burned tokens</span>', '\u2212' + usd(it.v), 'supply down \u00b7 share of backing paid', true); paint(-it.v); drawShelf(); }
    ];
    var order = [0, 1, 0, 1, 1, 2, 3, 1, 0, 1, 4, 1, 2, 1, 3, 0, 1, 1, 2, 3, 1, 4, 0, 1], k = 0;
    function next() { steps[order[k % order.length]](); k++; }
    next(); next(); next(); paint(0);
    if (!reduced) setInterval(next, 2400);
  })();

  // ── Send a card (the Admit door): eligible for THIS vault → pick one → sign the transfer → recorded ──
  var SD = { wallet: null, items: [], pick: null, busy: false };
  function sdRender() {
    $('sd-pick').innerHTML = SD.items.eligible.map(function (c) {
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<button type="button" class="pk' + (SD.pick === c.mint ? ' sel' : '') + '" data-mint="' + c.mint + '">' + ph + '<div class="t"><b>' + esc(c.name) + '</b><span>' + esc([c.gradingCompany, c.grade].filter(Boolean).join(' ')) + ' \u00b7 ' + usd(c.custodianValueUsd) + '</span></div></button>';
    }).join('') + SD.items.ineligible.map(function (x) {
      var ph = x.imageUrl ? '<img src="' + esc(x.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<div class="pk no" aria-disabled="true"><span class="why">' + esc(x.reason) + '</span>' + ph + '<div class="t"><b>' + esc(x.name) + '</b><span>cannot go in</span></div></div>';
    }).join('');
    var c = SD.items.eligible.filter(function (x) { return x.mint === SD.pick; })[0];
    $('sd-calc').style.display = c ? '' : 'none';
    if (c) { $('sd-val').textContent = usd2(c.custodianValueUsd); $('sd-real').textContent = usd2(c.realisableUsd); var bd = BANDS_DEF.filter(function (b) { return b.id === bandOf(c.custodianValueUsd || 0); })[0]; $('sd-owed').textContent = bd ? bd.label : '\u2014'; }
    $('sd-go').disabled = !c || SD.busy; $('sd-go').textContent = c ? (SD.wallet ? 'Send ' + c.name.slice(0, 24) : 'Connect wallet to send') : 'Pick a card';
  }
  function sdScan(addr) {
    $('sd-summary').textContent = 'Reading ' + short(addr) + '…'; SD.items = { eligible: [], ineligible: [] }; SD.pick = null; sdRender();
    get('/v1/vaults/' + VAULT + '/eligible-items?wallet=' + encodeURIComponent(addr)).then(function (b) {
      SD.items = b; $('sd-summary').textContent = b.total + ' tokens in ' + short(addr) + ' · ' + b.eligible.length + ' can go in · ' + b.ineligible.length + ' cannot (each says why)';
      sdRender();
    }).catch(function (e) { $('sd-summary').textContent = 'Could not read that wallet: ' + e.message; });
  }
  $('sd-pick').addEventListener('click', function (e) { var b = e.target.closest('button.pk'); if (!b) return; SD.pick = SD.pick === b.dataset.mint ? null : b.dataset.mint; sdRender(); });
  $('sd-scan').addEventListener('click', function () { var a = $('sd-addr').value.trim(); if (a) sdScan(a); });
  $('sd-addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var a = $('sd-addr').value.trim(); if (a) sdScan(a); } });
  function sdConnect() { return connectWallet().catch(function (e) { $('sd-msg').textContent = e.message === 'no wallet' ? 'No Solana wallet found in this browser — paste an address to see what could go in.' : 'Wallet connection was declined.'; throw e; }); }
  $('sd-go').addEventListener('click', function () {
    if (SD.busy) return;
    var c = SD.items.eligible.filter(function (x) { return x.mint === SD.pick; })[0]; if (!c) return;
    if (!SD.wallet) { sdConnect().catch(function () {}); return; }
    if (SD.wallet !== $('sd-addr').value.trim()) { $('sd-msg').textContent = 'The connected wallet is not the one scanned. Scan your own wallet to send from it.'; return; }
    var w = provider(); SD.busy = true; sdRender(); $('sd-go').textContent = 'Building…'; $('sd-msg').textContent = '';
    fetch('/v1/vaults/' + VAULT + '/admissions/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: SD.wallet, mint: c.mint }) })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (b.error) throw new Error(b.error);
        $('sd-go').textContent = 'Confirm in your wallet…';
        return signAndSend(w, b.transaction).then(function (sig) { return { sig: sig, b: b }; });
      })
      .then(function (x) {
        return fetch('/v1/vaults/' + VAULT + '/admissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint: c.mint, owner: SD.wallet, signature: x.sig, valueUsd: x.b.valueUsd }) })
          .then(function (r) { return r.json(); }).then(function (rec) {
            $('sd-msg').innerHTML = 'Sent · <a href="https://solscan.io/tx/' + x.sig + '" target="_blank" rel="noopener">' + x.sig.slice(0, 8) + '…</a> \u00b7 recorded, verifying on chain \u00b7 backing per token goes up when it lands. <a href="' + vpath() + '">See it in the vault →</a>';
            SD.pick = null; ITEMS = null; sdScan(SD.wallet);
          });
      })
      .catch(function (e) { $('sd-msg').textContent = e && e.message ? e.message : 'Cancelled.'; })
      .then(function () { SD.busy = false; sdRender(); });
  });
  SD.items = { eligible: [], ineligible: [] }; sdRender();

  // ── router ──
  function route() {
    var h = location.hash || '#/', m, id = 'home';
    if (h.indexOf('#/app') === 0) id = 'home';
    else if ((m = h.match(/^#\/vault\/([^\/]+)\/send$/))) { id = 'send'; selectVault(m[1]); $('sd-crumb-vault').textContent = META.name; $('sd-crumb-vault').href = vpath(); $('sd-back').href = vpath(); $('sd-sym').textContent = SYM(); if (META.rules) $('sd-rules').textContent = (META.name || 'This vault') + ' takes ' + META.rules.category.replace('-', ' ') + ' from ' + META.rules.custodians.join(', '); SD.items = { eligible: [], ineligible: [] }; SD.pick = null; sdRender(); }
    else if ((m = h.match(/^#\/vault\/([^\/]+)(?:\/(trade|play|items|activity|proof))?$/))) { id = 'vault'; selectVault(m[1]); renderVault(); showTab(m[2] || 'items'); }
    else if ((m = h.match(/^#\/item\/(.+)$/))) { id = 'item'; renderItem(m[1]); }
    else if (h.indexOf('#/create') === 0) { id = 'create'; step(1); if (W.addr) { scan(W.addr); checkResume(); } }
    else if (h.indexOf('#/integrate') === 0) id = 'integrate';
    else if (h.indexOf('#/how') === 0) id = 'how';
    if (id === 'home') renderBoard();
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) { s.classList.toggle('on', s.id === 's-' + id); });
    Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) { a.classList.toggle('on', a.dataset.nav === id || ((id === 'vault' || id === 'item' || id === 'send') && a.dataset.nav === 'home')); });
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);
  loadVaults().then(route).catch(function (e) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', '<p class="note warn" style="margin-top:24px"><b>The vault API is not answering.</b> ' + esc(e.message) + '</p>');
  });
})();
