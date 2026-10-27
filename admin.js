/* =========================================================
   BH Video — Admin dashboard logic
   - Password-gated login (POST /api/admin/login).
   - Fetches /api/admin/overview and renders:
       • KPIs (today UV, total plays, ad clicks)
       • Daily UV bar chart (30 days)
       • Ads table (impressions / clicks / CTR per slot)
       • Videos table (plays per episode, join with videos.js
         so we can show human-readable series + ep titles)
   - Token stored in sessionStorage so a page refresh keeps the
     session without surviving tab/browser restart.
   ========================================================= */

(function () {
  "use strict";

  const TOKEN_KEY = "bhv.adminToken";

  const AD_SLOT_LABELS = {
    top: "首部广告栏 (Top Banner)",
    bottom: "尾部广告栏 (Bottom Banner)",
    float: "悬浮广告 (Floating Box)",
    preroll: "插播广告视频 (Pre-roll)",
    preroll_cta: "插播广告按钮 (CTA)",
  };

  const loginScreen = document.getElementById("loginScreen");
  const loginForm = document.getElementById("loginForm");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");
  const dashboard = document.getElementById("dashboard");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const generatedAt = document.getElementById("generatedAt");

  const kpiUvToday = document.getElementById("kpiUvToday");
  const kpiUv30 = document.getElementById("kpiUv30");
  const kpiPlays = document.getElementById("kpiPlays");
  const kpiOpens = document.getElementById("kpiOpens");
  const kpiEnds = document.getElementById("kpiEnds");
  const kpiAdClicks = document.getElementById("kpiAdClicks");
  const kpiAdImpr = document.getElementById("kpiAdImpr");
  const kpiAdCtr = document.getElementById("kpiAdCtr");

  const uvChart = document.getElementById("uvChart");
  const adsTbody = document.getElementById("adsTbody");
  const videosTbody = document.getElementById("videosTbody");

  /* ---------- Token helpers ---------- */
  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function setToken(tok) {
    try {
      if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  /* ---------- Escape ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNumber(n) {
    const num = Number(n) || 0;
    return num.toLocaleString("zh-CN");
  }

  /* ---------- Login ---------- */
  function showLogin() {
    loginScreen.hidden = false;
    dashboard.hidden = true;
    loginPassword.value = "";
    loginError.hidden = true;
    setTimeout(() => loginPassword.focus(), 50);
  }

  function showDashboard() {
    loginScreen.hidden = true;
    dashboard.hidden = false;
  }

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.hidden = true;
    const password = loginPassword.value;
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    })
      .then(function (r) {
        if (r.status === 401) {
          throw new Error("密码错误");
        }
        if (!r.ok) throw new Error("登录失败 (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !data.token) throw new Error("登录失败");
        setToken(data.token);
        showDashboard();
        loadOverview();
      })
      .catch(function (err) {
        loginError.textContent = (err && err.message) || "登录失败";
        loginError.hidden = false;
      });
  });

  logoutBtn.addEventListener("click", function () {
    setToken("");
    showLogin();
  });

  refreshBtn.addEventListener("click", function () {
    loadOverview();
  });

  /* ---------- Load dashboard data ---------- */
  function loadOverview() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }
    refreshBtn.disabled = true;
    refreshBtn.textContent = "加载中…";

    fetch("/api/admin/overview?token=" + encodeURIComponent(token), {
      headers: { Authorization: "Bearer " + token },
    })
      .then(function (r) {
        if (r.status === 401) {
          setToken("");
          showLogin();
          throw new Error("会话已过期，请重新登录");
        }
        if (!r.ok) throw new Error("请求失败 (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("返回数据异常");
        renderAll(data);
      })
      .catch(function (err) {
        console.error("[admin] load failed", err);
      })
      .then(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "刷新";
      });
  }

  /* ---------- Render ---------- */
  function renderAll(data) {
    generatedAt.textContent = "数据生成于 " + (data.generated_at || "-");

    renderKpis(data);
    renderUvChart(data.visits && data.visits.last_30_days);
    renderAdsTable(data.ads && data.ads.slots);
    renderVideosTable(data.videos && data.videos.episodes);
  }

  function renderKpis(data) {
    const visits = data.visits || {};
    const videos = (data.videos && data.videos.totals) || {};
    const adsTot = (data.ads && data.ads.totals) || {};

    kpiUvToday.textContent = formatNumber(visits.today || 0);
    kpiUv30.textContent = formatNumber(visits.total_30d || 0);

    kpiPlays.textContent = formatNumber(videos.plays || 0);
    kpiOpens.textContent = formatNumber(videos.opens || 0);
    kpiEnds.textContent = formatNumber(videos.ends || 0);

    kpiAdClicks.textContent = formatNumber(adsTot.clicks || 0);
    kpiAdImpr.textContent = formatNumber(adsTot.impressions || 0);
    kpiAdCtr.textContent = (adsTot.ctr || 0).toFixed(2) + "%";
  }

  function renderUvChart(series) {
    if (!Array.isArray(series) || !series.length) {
      uvChart.innerHTML = '<div class="admin-muted">暂无访问数据</div>';
      return;
    }
    const max = Math.max.apply(
      null,
      series.map(function (p) {
        return p.uv || 0;
      })
    );
    const safeMax = max > 0 ? max : 1;
    uvChart.innerHTML = series
      .map(function (p) {
        const pct = Math.round(((p.uv || 0) / safeMax) * 100);
        const h = p.uv > 0 ? Math.max(pct, 4) : 0;
        return (
          '<div class="uv-bar" data-uv="' +
          esc(p.uv) +
          '" style="height:' +
          h +
          '%">' +
          '<span class="uv-tip">' +
          esc(p.date) +
          "：" +
          esc(formatNumber(p.uv)) +
          " 人</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderAdsTable(slots) {
    if (!slots || typeof slots !== "object") {
      adsTbody.innerHTML =
        '<tr class="empty-row"><td colspan="4">暂无广告数据</td></tr>';
      return;
    }
    const rows = Object.keys(slots).map(function (slot) {
      const row = slots[slot] || {};
      const label = AD_SLOT_LABELS[slot] || slot;
      return (
        "<tr>" +
        '<td><span class="slot-tag">' +
        esc(slot) +
        "</span> " +
        esc(label) +
        "</td>" +
        '<td class="num">' +
        formatNumber(row.impressions) +
        "</td>" +
        '<td class="num">' +
        formatNumber(row.clicks) +
        "</td>" +
        '<td class="num">' +
        (Number(row.ctr) || 0).toFixed(2) +
        "%</td>" +
        "</tr>"
      );
    });
    adsTbody.innerHTML =
      rows.join("") ||
      '<tr class="empty-row"><td colspan="4">暂无广告数据</td></tr>';
  }

  function renderVideosTable(episodeMap) {
    if (!episodeMap || typeof episodeMap !== "object") {
      videosTbody.innerHTML =
        '<tr class="empty-row"><td colspan="7">暂无视频播放数据</td></tr>';
      return;
    }

    // Join episode stats with videos.js so we can display human
    // titles. Fall back to the raw id when the series is not in the
    // built-in catalog (e.g. imported after the admin page loaded).
    const Catalog = window.VideoCatalog;
    const seriesMap = {};
    (window.VIDEOS || []).forEach(function (s) {
      seriesMap[s.id] = s;
    });

    const rows = Object.keys(episodeMap)
      .map(function (key) {
        const entry = episodeMap[key] || {};
        // Key may be "<seriesId>:ep<n>" or legacy "<id>".
        const m = /^(.*):ep(\d+)$/.exec(key);
        let seriesId = key;
        let epNum = "";
        if (m) {
          seriesId = m[1];
          epNum = m[2];
        }
        const series = seriesMap[seriesId];
        const seriesTitle = series ? series.title : seriesId;
        const episode =
          series && Catalog ? Catalog.findEpisode(series, Number(epNum)) : null;
        const epTitle = episode ? episode.title : epNum ? "第" + epNum + "集" : "";

        const opens = Number(entry.opens) || 0;
        const plays = Number(entry.plays) || 0;
        const ends = Number(entry.ends) || 0;
        const finishRate = plays > 0 ? (ends / plays) * 100 : 0;
        return {
          seriesTitle: seriesTitle,
          epTitle: epTitle,
          opens: opens,
          plays: plays,
          ends: ends,
          finishRate: finishRate,
        };
      })
      .sort(function (a, b) {
        return b.plays - a.plays;
      });

    if (!rows.length) {
      videosTbody.innerHTML =
        '<tr class="empty-row"><td colspan="7">暂无视频播放数据</td></tr>';
      return;
    }

    videosTbody.innerHTML = rows
      .map(function (r, i) {
        return (
          "<tr>" +
          "<td>" +
          (i + 1) +
          "</td>" +
          "<td>" +
          esc(r.seriesTitle) +
          "</td>" +
          "<td>" +
          esc(r.epTitle) +
          "</td>" +
          '<td class="num">' +
          formatNumber(r.opens) +
          "</td>" +
          '<td class="num"><strong>' +
          formatNumber(r.plays) +
          "</strong></td>" +
          '<td class="num">' +
          formatNumber(r.ends) +
          "</td>" +
          '<td class="num">' +
          r.finishRate.toFixed(1) +
          "%</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  /* ---------- Boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    // Also load the imported library so the videos table can show
    // human-readable titles for user-imported series.
    fetch("/api/library")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (
          data &&
          Array.isArray(data.imported) &&
          window.VideoCatalog &&
          window.VideoCatalog.mergeImported
        ) {
          window.VideoCatalog.mergeImported(data.imported);
        }
      })
      .catch(function () {})
      .then(function () {
        if (getToken()) {
          showDashboard();
          loadOverview();
        } else {
          showLogin();
        }
      });
  });
})();
