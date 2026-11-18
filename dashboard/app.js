// Token Radar dashboard. Static, no network: all data comes from data.js
// beside this page, written by main.ts from the sealed snapshot. The board
// is ranked by implied launch value; every row recomputes its own implied
// value in the detail view so the judge can audit it.
(function () {
  var D = window.TOKEN_RADAR_DATA;
  if (!D) {
    document.body.innerHTML = "<p>Data file missing: run main.ts first.</p>";
    return;
  }
  var rows = D.rows;
  var topImplied = rows.length ? rows[0].implied_value_usd : 1;

  var state = { verdict: "All", category: "All", q: "", sort: "implied", tab: "board" };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function short(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n;
  }
  function full(n) { return "$" + n.toLocaleString("en-US"); }
  function pct(x) {
    if (x === null || x === undefined) return "—";
    var s = (x > 0 ? "+" : "") + x.toFixed(1) + "%";
    return '<span class="' + (x > 0.5 ? "up" : x < -0.5 ? "down" : "flat") + '">' + s + "</span>";
  }
  function ageText(r) {
    if (r.age_days === null) return "unknown";
    if (r.age_days < 30) return r.age_days + "d";
    if (r.age_days < 365) return Math.round(r.age_days / 30) + "mo";
    return (r.age_days / 365).toFixed(1) + "y";
  }

  // ---- facts strip
  var c = D.counts;
  $("facts").innerHTML =
    fact(rows.length, "board rows") + fact(c.watchlist + " / 40", "watchlist covered") +
    fact(c.farm, "Farm") + fact(c.thin, "Thin") + fact(c.skip, "Skip") +
    fact(short(rows[0].implied_value_usd), "top implied value") +
    fact(D.model.comps_n, "traded comps") +
    fact(D.model.blind.median_abs_error_pct + "%", "blind-test median miss");
  function fact(b, label) {
    return '<div class="fact"><b>' + esc(String(b)) + "</b><span>" + esc(label) + "</span></div>";
  }
  $("live-count").textContent = "(" + D.live.length + ")";

  // ---- category filter options
  var cats = {};
  rows.forEach(function (r) { cats[r.category || "Uncategorised"] = true; });
  Object.keys(cats).sort().forEach(function (cat) {
    var o = document.createElement("option");
    o.value = cat; o.textContent = cat;
    $("category").appendChild(o);
  });

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.verdict !== "All" && r.verdict !== state.verdict) return false;
      if (state.category !== "All" && (r.category || "Uncategorised") !== state.category) return false;
      if (q && (r.name + " " + r.slug + " " + (r.category || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (state.sort === "tvl") list.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (state.sort === "name") list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else if (state.sort === "age") list.sort(function (a, b) { return (b.age_days || 0) - (a.age_days || 0); });
    else list.sort(function (a, b) { return a.rank - b.rank; });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    $("row-count").textContent = list.length + " of " + rows.length + " rows";
    $("rows").innerHTML = list.map(function (r) {
      var chains = r.chains.slice(0, 3).join(", ") + (r.chains.length > 3 ? " +" + (r.chains.length - 3) : "");
      var w = Math.max(2, Math.round((r.implied_value_usd / topImplied) * 100));
      return '<tr data-slug="' + esc(r.slug) + '"><td class="mono">' + r.rank + "</td>" +
        '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + "</div></td>" +
        "<td>" + esc(r.category || "—") + "</td>" +
        '<td class="chains">' + esc(chains) + "</td>" +
        '<td class="num mono">' + short(r.tvl_usd) + "</td>" +
        '<td class="num">' + pct(r.change_7d) + "</td>" +
        '<td class="num mono">' + short(r.implied_value_usd) + '<div class="bar"><i style="width:' + w + '%"></i></div></td>' +
        '<td><span class="badge ' + r.verdict + '">' + r.verdict + "</span></td></tr>";
    }).join("");
    $("rows").querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-slug")); });
    });
  }

  function renderLive() {
    $("live-rows").innerHTML = D.live.map(function (p) {
      return "<tr><td><div class=\"name\">" + esc(p.name) + '</div><div class="slug">' + esc(p.slug) +
        (p.symbol ? " · " + esc(p.symbol) : "") + "</div></td>" +
        "<td>" + esc(p.category || "—") + "</td>" +
        '<td class="num mono">' + short(p.tvl_usd) + "</td>" +
        '<td class="num mono">' + short(p.mcap_usd) + "</td>" +
        '<td class="num mono">' + p.multiple.toFixed(3) + "</td></tr>";
    }).join("");
  }

  // ---- model panel: formula, blind test, fitted multiples
  var m = D.model;
  var multRows = m.multiples.map(function (x) {
    return "<tr><td>" + esc(x.category) + "</td><td class=\"num\">" + x.n +
      '</td><td class="num mono">' + x.multiple.toFixed(4) + "</td><td>" + x.source + "</td></tr>";
  }).join("");
  $("model").innerHTML =
    "<h2>How the value is worked out — model " + esc(m.name) + "</h2>" +
    "<p>Each protocol's implied value is its TVL times a multiple fitted from traded protocols in the same " +
    "category — the median market-cap / TVL of " + m.comps_n + " comps. When a category has fewer than 5 comps " +
    "the global median (" + m.global_multiple.toFixed(4) + ") is used instead. The multiple is rounded to 4 dp " +
    "once, at fit time, so the dashboard's recompute agrees with the board to the dollar.</p>" +
    "<p><code>" + esc(m.formula) + "</code></p>" +
    "<p>Blind test — every 5th traded comp held out, fitted on the rest: median absolute error " +
    "<b>" + m.blind.median_abs_error_pct + "%</b>, " + m.blind.within_2x_pct + "% within 2x, " +
    m.blind.within_3x_pct + "% within 3x (" + m.blind.held_out + " held out, " + m.blind.fitted_on +
    " fitted on). The model ranks; it does not price. Verdicts: <b>Farm</b> at implied $100M+ with 7-day " +
    "growth no worse than -25%, <b>Thin</b> at $25M+, else <b>Skip</b>. Snapshot " + esc(m.as_of) +
    ", " + m.snapshot_protocols + " protocols, watchlist floor " + short(m.floor_usd) + ".</p>" +
    "<table><thead><tr><th>Category (5+ comps)</th><th class=\"num\">Comps</th>" +
    "<th class=\"num\">Multiple</th><th>Source</th></tr></thead><tbody>" + multRows + "</tbody></table>";

  // ---- detail view
  function recompute(r) {
    var v = Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_factor * r.maturity_factor));
    return v;
  }
  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) r = rows[i];
    if (!r) return;
    var again = recompute(r);
    var ok = again === r.implied_value_usd;
    var compNote = r.multiple_source === "category"
      ? "Category multiple: median mcap/TVL of " + r.multiple_n + " traded " + (r.category || "") + " comps."
      : "Category has fewer than 5 traded comps, so the global median multiple is used.";
    $("sheet").innerHTML =
      '<button class="close" id="close">Close ✕</button>' +
      "<h2>" + esc(r.name) + ' <span class="badge ' + r.verdict + '">' + r.verdict + "</span></h2>" +
      '<div class="meta">Rank #' + r.rank + " · " + esc(r.category || "Uncategorised") + " · " +
      esc(r.chains.join(", ")) + " · tracked " + ageText(r) +
      (r.watchlist ? " · on the house watchlist" : " · below the watchlist floor") + "</div>" +
      '<div class="stats">' +
      stat(full(r.implied_value_usd), "implied value") + stat(full(r.tvl_usd), "TVL") +
      stat(r.multiple.toFixed(4), "multiple (" + r.multiple_source + ")") + stat(pctText(r.change_7d), "TVL change 7d") +
      "</div>" +
      '<div class="audit' + (ok ? "" : " bad") + '">Audit: ' + full(r.tvl_usd) + " TVL × " + r.multiple.toFixed(4) +
      " multiple × " + r.growth_factor.toFixed(3) + " growth × " + r.maturity_factor.toFixed(3) +
      " maturity = <b>" + full(again) + "</b> — " + (ok ? "the same number board.json carries." : "DIFFERS from board.json.") + "</div>" +
      "<p>" + esc(compNote) + " Age counts from the snapshot's listed date; unknown age counts as 365 days. " +
      "The protocol records no token in the snapshot — that is the record, not proof it has none.</p>" +
      "<h3>Farm plan</h3><ol>" + r.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" +
      "<h3>Risks</h3><ul>" + r.risks.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ul>";
    $("overlay").hidden = false;
    $("close").addEventListener("click", closeDetail);
    document.body.style.overflow = "hidden";
  }
  function stat(b, label) {
    return '<div class="stat"><b>' + esc(String(b)) + "</b><span>" + esc(label) + "</span></div>";
  }
  function pctText(x) {
    if (x === null || x === undefined) return "n/a";
    return (x > 0 ? "+" : "") + x.toFixed(1) + "%";
  }
  function closeDetail() {
    $("overlay").hidden = true;
    document.body.style.overflow = "";
  }
  $("overlay").addEventListener("click", function (e) { if (e.target === $("overlay")) closeDetail(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDetail(); });

  // ---- tabs
  function setTab(tab) {
    state.tab = tab;
    $("tab-board").classList.toggle("on", tab === "board");
    $("tab-live").classList.toggle("on", tab === "live");
    $("board-view").hidden = tab !== "board";
    $("live-view").hidden = tab !== "live";
    $("board-controls").style.display = tab === "board" ? "" : "none";
    if (tab === "live") renderLive();
  }
  $("tab-board").addEventListener("click", function () { setTab("board"); });
  $("tab-live").addEventListener("click", function () { setTab("live"); });

  // ---- controls
  $("q").addEventListener("input", function (e) { state.q = e.target.value; renderBoard(); });
  $("verdict").addEventListener("change", function (e) { state.verdict = e.target.value; renderBoard(); });
  $("category").addEventListener("change", function (e) { state.category = e.target.value; renderBoard(); });
  $("sort").addEventListener("change", function (e) { state.sort = e.target.value; renderBoard(); });

  renderBoard();

  // ---- screenshot pins: ?shot=board | detail&slug=… | filtered&verdict=…
  var params = new URLSearchParams(window.location.search);
  var shot = params.get("shot");
  if (shot === "filtered") {
    var v = params.get("verdict") || "Farm";
    state.verdict = v;
    $("verdict").value = v;
    renderBoard();
  } else if (shot === "detail") {
    openDetail(params.get("slug") || rows[0].slug);
  }
})();
