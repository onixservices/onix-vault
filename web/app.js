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

  // ── board ──
  function tile(v) {
    var st = v.stats, p = st && st.pool, sym = '$' + ((v.token && v.token.symbol) || 'TOKEN');
    var pct = p ? Math.round((p.graduationProgress || 0) * 100) : 0;
    return '<a class="vcard" href="#/vault/' + v.id + '"><div class="strip" data-strip="' + v.vault + '"></div><div class="body">'
      + '<div class="head"><b>' + esc(v.name) + '</b><span class="tag gold">operated by ' + esc(v.operator || '—') + '</span></div>'
      + '<div class="kv"><div><span class="l">Backing</span><span class="x g">' + (st ? usd(st.backing.realisableUsd) : '—') + '</span></div><div><span class="l">Market cap</span><span class="x">' + (p ? usd(p.mcapUsd) : '—') + '</span></div><div><span class="l">Ratio</span><span class="x">' + (p && p.ratio != null ? p.ratio.toFixed(2) + '×' : '—') + '</span></div></div>'
      + '<div class="prog"><i style="width:' + pct + '%"></i></div>'
      + '<p class="faint" style="font-size:12.5px">' + (st ? st.items.count : '—') + ' items · ' + esc(v.description || (v.custodians || []).join(', ')) + ' · ' + (p ? pct + '% of the way to the open market' : 'token ' + (st ? st.poolStatus : '—')) + '</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><span class="cta sm">Buy ' + esc(sym) + '</span><span class="cta ghost sm">Send a card</span></div></div></a>';
  }
  function renderBoard() {
    $('board').innerHTML = VAULTS.map(tile).join('') + '<a class="vcard empty" href="#/create"><b>Your vault</b><p>Watches, wine, comics, cards. If a custodian you trust has put it on chain, it can back a token.</p><span class="cta sm">Create a vault</span></a>';
    VAULTS.forEach(function (v) {
      get('/v1/vaults/' + v.vault + '/items').then(function (b) {
        var el = document.querySelector('[data-strip="' + v.vault + '"]'); if (!el) return;
        el.innerHTML = b.items.slice(0, 5).map(function (c) { return c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span></span>'; }).join('');
      });
    });
    var st0 = VAULTS[0] && VAULTS[0].stats;
    $('b-live').textContent = VAULTS.length ? VAULTS.length + ' vault' + (VAULTS.length === 1 ? '' : 's') + ' · read from chain' : 'no vaults yet';
    $('b-pool').textContent = st0 && st0.pool ? 'token: trading' : st0 ? 'token: ' + st0.poolStatus : 'create the first one';
  }
  // ── vault page ──
  function renderVault() {
    loadStats().then(function (st) {
      $('v-eyebrow').textContent = (META.name || 'Vault') + ' · operated by ' + (META.operator || '—') + ' · wallet ' + short(VAULT);
      $('v-crumb').textContent = META.name || 'Vault'; $('v-send').href = vpath('/send'); $('t-sym').textContent = SYM();
      $('v-n').textContent = st.items.count; $('v-n2').textContent = st.items.count;
      var tk = META.token || {};
      if (tk.name) $('tk-name').textContent = tk.name; if (tk.symbol) $('tk-sym').textContent = '$' + tk.symbol; if (tk.image) $('tk-img').src = tk.image;
      $('tk-tags').innerHTML = st.pool
        ? '<span class="tag live">trading</span><a class="tag" href="https://solscan.io/token/' + st.pool.baseMint + '" target="_blank" rel="noopener">mint ' + short(st.pool.baseMint) + '</a><a class="tag" href="https://solscan.io/account/' + st.pool.address + '" target="_blank" rel="noopener">pool ' + short(st.pool.address) + '</a><span class="tag">10% of every trade feeds the vault</span>'
        : '<span class="tag">' + st.poolStatus + '</span>';
      var g = st.pool && st.pool.graduationUsd ? st.pool.graduationUsd : (META.graduationUsd || 3500);
      $('m-grad').textContent = usd(g);
      if (st.pool) {
        var pr = Math.round((st.pool.graduationProgress || 0) * 100);
        $('m-pct').textContent = pr + '%'; $('m-prog').style.width = pr + '%';
        $('m-raised').textContent = usd(st.pool.mcapUsd); $('m-left').textContent = usd(Math.max(0, g - st.pool.mcapUsd));
        $('m-price').textContent = price(st.pool.priceUsd); $('m-fees').textContent = usd2(st.pool.feesLifetimeUsd);
      } else { $('m-pct').textContent = '—'; $('m-prog').style.width = '0%'; $('m-raised').textContent = '—'; $('m-left').textContent = '—'; $('m-price').textContent = '—'; $('m-fees').textContent = '—'; }
      $('v-idx').textContent = st.backing.indexUsd.toLocaleString('en-US'); $('v-mult').textContent = st.backing.multiplier;
      $('v-back').textContent = usd(st.backing.realisableUsd);
      $('v-age').textContent = ago(st.ageMs);
      $('p-wallet').textContent = VAULT;
      tradePanel(st);
      if (st.pool) {
        $('v-mcap').textContent = usd(st.pool.mcapUsd);
        $('v-mcap-sub').textContent = 'Token price ' + price(st.pool.priceUsd) + ' × ' + st.pool.supply.toLocaleString('en-US') + ' tokens in circulation.';
        var r = st.pool.ratio; $('v-ratio').textContent = r != null ? r.toFixed(2) + '×' : '—';
        var pin = $('v-pin'); if (r != null) { pin.style.display = ''; pin.textContent = r.toFixed(2); pin.style.left = (28 + Math.max(-0.2, Math.min(1.2, (r - 0.87) / (1.25 - 0.87))) * 50) + '%'; }
        $('p-pool').textContent = 'Pool ' + st.pool.address + ' · mint ' + st.pool.baseMint + ' · fees so far ' + usd2(st.pool.feesLifetimeUsd) + '.';
      } else {
        $('v-mcap').textContent = '—'; $('v-mcap-sub').textContent = 'The token has ' + st.poolStatus + '. No price yet, so no number here: we do not make one up.';
        $('v-ratio').textContent = '—'; $('v-pin').style.display = 'none';
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
        if (e.type === 'admit') { return '<div class="row"><span class="k">Admitted</span><span class="muted"><a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> · sent by ' + short(e.from) + ' · ' + usd2(e.valueUsd) + ' listed → ' + (e.tokens === 'locked' ? Math.round(e.tokensAmount).toLocaleString('en-US') + ' ' + SYM() + ' bought on the curve for ' + usd2(e.owedUsd) + ', locked until ' + new Date(e.unlockAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'owed ' + usd2(e.owedUsd) + ' in ' + SYM() + (e.status === 'pending' ? ' · verifying on chain' : e.tokens === 'waiting' ? ' · ' + e.tokensNote : ' · buying on the curve')) + '</span><span class="sig"><a href="https://solscan.io/tx/' + e.signature + '" target="_blank" rel="noopener">transfer</a>' + (e.tokensSignature ? ' · <a href="https://solscan.io/tx/' + e.tokensSignature + '" target="_blank" rel="noopener">tokens</a>' : '') + '</span></div>'; }
        var k = e.type === 'gacha' ? 'Gacha' : 'Redeemed';
        var what = e.type === 'gacha' ? 'a gacha paid ' + usd2(e.priceUsd) + ' → delivered to ' + short(e.to) : 'tokens burned → ' + (e.status === 'delivered' ? 'delivered to ' : e.status + ' · ') + short(e.to);
        var sigs = (e.paymentSignature ? '<a href="https://solscan.io/tx/' + e.paymentSignature + '" target="_blank" rel="noopener">payment</a>' : '')
          + (e.burnSignature ? '<a href="https://solscan.io/tx/' + e.burnSignature + '" target="_blank" rel="noopener">burn</a>' : '')
          + (e.deliverySignature ? ' · <a href="https://solscan.io/tx/' + e.deliverySignature + '" target="_blank" rel="noopener">delivery</a>' : ' · delivery pending');
        return '<div class="row"><span class="k">' + k + '</span><span class="muted"><a href="#/item/' + e.mint + '">' + short(e.mint) + '</a> · ' + what + '</span><span class="sig">' + sigs + '</span></div>';
      }).join('');
    });
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
    if ($('s-create').classList.contains('on')) { if (a) scan(a); else { CQ = null; $('c-summary').textContent = 'Connect your wallet (top right) to see what it can open a vault on.'; renderPick(); } }
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
    el.classList.toggle('off', !p);
    $('t-state').textContent = p ? (st.poolStatus === 'live' ? 'trading' : st.poolStatus) : 'not launched';
    $('t-state').className = 'tag' + (p ? ' live' : '');
    $('t-price').textContent = p ? price(p.priceUsd) : '—';
    $('t-mcap').textContent = p ? usd(p.mcapUsd) : '—';
    $('t-fees2').textContent = p ? usd2(p.feesLifetimeUsd) : '—';
    $('t-go').textContent = p ? (T.wallet ? (T.side === 'buy' ? 'Buy' : 'Sell') : 'Connect wallet') : 'Opens when the token launches';
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
          if (/insufficient liquidity/i.test(q.error)) $('t-quote').textContent = 'That is more than the curve holds.' + (h != null ? ' You have ' + (T.side === 'buy' ? '$' + h.toFixed(2) + ' USDC' : Math.floor(h).toLocaleString('en-US') + ' ' + SYM()) + ' — use Max.' : '');
          else $('t-quote').textContent = q.error;
          return;
        }
        $('t-quote').textContent = 'You receive ≈ ' + (T.side === 'buy' ? Math.round(q.amountOut).toLocaleString('en-US') + ' ' + SYM() : usd2(q.amountOut)) + ' · fee ' + usd2(q.tradingFeeUsd + q.protocolFeeUsd) + ' · min ' + (T.side === 'buy' ? Math.round(q.minimumAmountOut).toLocaleString('en-US') : usd2(q.minimumAmountOut)) + ' (1% slippage)';
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
      $('i-redeem-usd').textContent = usd2(c.redeemPriceUsd);
      $('i-redeem-tok').textContent = STATS && STATS.pool ? '≈ ' + Math.round(c.redeemPriceUsd / STATS.pool.priceUsd).toLocaleString('en-US') + ' ' + SYM() + ' at today\'s price · listed value + 15%' : 'listed value + 15% · in tokens once trading opens';
      $('i-exit').textContent = usd2(c.exitPriceUsd);
      var res = c.status === 'reserved';
      $('i-status').textContent = res ? 'Reserved' + (c.reservedUntil ? ' · ' + Math.max(0, Math.round((c.reservedUntil - Date.now()) / 60000)) + ' min' : '') : 'Available';
      $('i-status').className = 'x ' + (res ? 'w' : 'v');
      $('i-admit').innerHTML = '<a href="https://solscan.io/token/' + c.mint + '" target="_blank" rel="noopener">token on Solscan</a>';
      $('i-crumb-vault').textContent = META.name || 'Vault'; $('i-crumb-vault').href = vpath(); $('i-buy').href = vpath();
    }
  }

  // ── create: the connected wallet is the vault ──
  var CQ = null, CR = { busy: false }, CSEL = {};
  function renderPick() {
    var q = CQ;
    $('pick').innerHTML = !q ? '' : q.items.map(function (c) {
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<button type="button" class="pk' + (CSEL[c.mint] ? ' sel' : '') + '" data-mint="' + c.mint + '">' + ph + '<div class="t"><b>' + esc(c.name) + '</b><span>' + usd(c.custodianValueUsd) + '</span></div></button>';
    }).join('');
    $('c-calc').style.display = q ? '' : 'none';
    var n = 0, idx = 0; if (q) q.items.forEach(function (c) { if (CSEL[c.mint]) { n++; idx += c.custodianValueUsd; } });
    var real = Math.round(idx * 0.89 * 100) / 100;
    CQ_PICK = { n: n, indexUsd: idx, realisableUsd: real, openingMcapUsd: Math.round(real * 2 * 100) / 100, graduationUsd: Math.round(real * 2 * 2.5 * 100) / 100 };
    if (q) { $('c-sel').textContent = n; $('c-idx').textContent = usd(idx); $('c-real').textContent = usd(real); $('c-get').textContent = usd(real); }
    $('to2').disabled = !(q && n > 0 && real >= 5);
  }
  function scan(addr) {
    $('c-summary').textContent = 'Reading ' + short(addr) + ' from the chain…'; CQ = null; renderPick();
    get('/v1/vaults/create/quote?wallet=' + encodeURIComponent(addr)).then(function (q) {
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
    $('c2-msg').textContent = '';
    $('r-name').textContent = name; $('r-sym').textContent = '$' + sym; $('r-real').textContent = usd(CQ_PICK.realisableUsd); $('r-sel').textContent = CQ_PICK.n + ' item' + (CQ_PICK.n === 1 ? '' : 's');
    $('r-open').textContent = usd(CQ_PICK.openingMcapUsd); $('r-grad').textContent = usd(CQ_PICK.graduationUsd); $('r-get').textContent = usd(CQ_PICK.realisableUsd);
    return true;
  }
  var CQ_PICK = { n: 0 };
  $('pick').addEventListener('click', function (e) { var b = e.target.closest('button.pk'); if (!b) return; CSEL[b.dataset.mint] = !CSEL[b.dataset.mint]; renderPick(); });
  $('to2').addEventListener('click', function () { if (CQ && CQ_PICK.n > 0) step(2); });
  $('to3').addEventListener('click', function () { if (review()) step(3); });
  $('back1').addEventListener('click', function () { step(1); });
  $('back2').addEventListener('click', function () { step(2); });
  $('f-sym').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('c-launch').addEventListener('click', function () {
    if (CR.busy || !CQ || !W.addr) return;
    var name = $('f-name').value.trim(), sym = $('f-sym').value.trim().toUpperCase();
    var w = provider(); if (!w) { $('c-msg').textContent = 'No Solana wallet found in this browser.'; return; }
    CR.busy = true; $('c-launch').disabled = true; $('c-msg').textContent = 'Setting up the curve (Onix signs this part)…';
    var creationId = null;
    fetch('/v1/vaults/create/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: W.addr, name: name, symbol: sym, mints: Object.keys(CSEL).filter(function (m) { return CSEL[m]; }) }) })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (b.error) throw new Error(b.error);
        creationId = b.creationId;
        $('c-msg').textContent = 'Sign the launch in your wallet…';
        return signAndSend(w, b.transaction);
      })
      .then(function (sig) {
        $('c-msg').textContent = 'Launched: ' + short(sig) + ' · confirming on chain…';
        var tries = 0;
        return (function confirmLoop() {
          tries++;
          return fetch('/v1/vaults/create/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creationId: creationId, signature: sig }) })
            .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
            .then(function (x) {
              if (x.status === 201) return x.body.vault;
              if (x.status === 409 && tries < 20) return new Promise(function (res) { setTimeout(res, 3000); }).then(confirmLoop);
              throw new Error(x.body.error || 'could not confirm');
            });
        })();
      })
      .then(function (v) {
        $('c-msg').textContent = 'Your vault is live.';
        return loadVaults().then(function () { location.hash = '#/vault/' + v.id; });
      })
      .catch(function (e) { $('c-msg').textContent = (e && e.message) || String(e); })
      .then(function () { CR.busy = false; $('c-launch').disabled = false; });
  });
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

  // ── Send a card (the Admit door): eligible for THIS vault → pick one → sign the transfer → recorded ──
  var SD = { wallet: null, items: [], pick: null, busy: false };
  function sdRender() {
    $('sd-pick').innerHTML = SD.items.eligible.map(function (c) {
      var ph = c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<button type="button" class="pk' + (SD.pick === c.mint ? ' sel' : '') + '" data-mint="' + c.mint + '">' + ph + '<div class="t"><b>' + esc(c.name) + '</b><span>' + esc([c.gradingCompany, c.grade].filter(Boolean).join(' ')) + ' · ' + usd(c.custodianValueUsd) + ' → ' + usd2(c.owedUsd) + '</span></div></button>';
    }).join('') + SD.items.ineligible.map(function (x) {
      var ph = x.imageUrl ? '<img src="' + esc(x.imageUrl) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:3/4;background:var(--tile)"></div>';
      return '<div class="pk no" aria-disabled="true"><span class="why">' + esc(x.reason) + '</span>' + ph + '<div class="t"><b>' + esc(x.name) + '</b><span>cannot go in</span></div></div>';
    }).join('');
    var c = SD.items.eligible.filter(function (x) { return x.mint === SD.pick; })[0];
    $('sd-calc').style.display = c ? '' : 'none';
    if (c) { $('sd-val').textContent = usd2(c.custodianValueUsd); $('sd-real').textContent = usd2(c.realisableUsd); $('sd-owed').textContent = usd2(c.owedUsd); }
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
            $('sd-msg').innerHTML = 'Sent · <a href="https://solscan.io/tx/' + x.sig + '" target="_blank" rel="noopener">' + x.sig.slice(0, 8) + '…</a> · recorded, verifying on chain · you are owed ' + usd2(rec.owedUsd) + ' in ' + SYM() + ', locked ' + rec.lockMonths + ' months. <a href="' + vpath() + '">See it in the vault →</a>';
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
    else if ((m = h.match(/^#\/vault\/([^\/]+)/))) { id = 'vault'; selectVault(m[1]); renderVault(); }
    else if ((m = h.match(/^#\/item\/(.+)$/))) { id = 'item'; renderItem(m[1]); }
    else if (h.indexOf('#/create') === 0) { id = 'create'; step(1); if (W.addr) scan(W.addr); }
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
