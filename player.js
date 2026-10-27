/* =========================================================
   BH Video — Player page logic (series / episodes model)
   - URL: player.html?id=<seriesId>&ep=<n>
   - Loads the matching series/episode into the <video> element.
   - Sidebar shows the episode list of THE SAME series.
   - Per-episode play counters live under composite ids
     "<seriesId>:ep<n>" on the backend.
   - All user-facing strings go through window.I18N.
   ========================================================= */

(function () {
  "use strict";

  const Catalog = window.VideoCatalog;

  const videoEl = document.getElementById("videoPlayer");
  const titleEl = document.getElementById("videoTitle");
  const viewsEl = document.getElementById("videoViews");
  const epCountEl = document.getElementById("videoEpCount");
  const categoryEl = document.getElementById("videoCategory");
  const tagsEl = document.getElementById("videoTags");
  const descEl = document.getElementById("videoDescription");
  const upNextList = document.getElementById("upNextList");
  const upNextTitleEl = document.getElementById("upNextTitle");
  const likeBtn = document.getElementById("likeBtn");
  const shareBtn = document.getElementById("shareBtn");

  const i18n = window.I18N || {
    t: (k) => k,
    pickLocalized: (v, f) => (v ? v[f] : ""),
    localizeCategory: (c) => c,
    onChange: () => () => {},
  };
  const t = (k, p) => i18n.t(k, p);

  // Latest play counts. Shape: { "<seriesId>:ep<n>": { opens, plays, ends } }.
  let playStats = {};
  // Track which episode key already reported a "play" event so we count at
  // most once per navigation.
  let playReportedFor = null;

  /** Format a play count (e.g. 1.2M, 12.3K, 999). */
  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000)
      return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(num);
  }

  function parseViewsLabel(label) {
    if (label == null) return 0;
    const s = String(label).trim().toUpperCase();
    const m = s.match(/^([\d.]+)\s*([KM]?)$/);
    if (!m) return Number(s) || 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    if (m[2] === "M") return Math.round(n * 1_000_000);
    if (m[2] === "K") return Math.round(n * 1_000);
    return Math.round(n);
  }

  /** Pick the label to show next to the views suffix for an episode. */
  function episodeViewsLabel(seriesId, ep) {
    if (!ep) return "";
    const key = Catalog.episodeKey(seriesId, ep.ep);
    const entry = playStats && playStats[key];
    if (entry && typeof entry.plays === "number" && entry.plays > 0) {
      return formatCount(entry.plays);
    }
    return ep.views || "0";
  }

  /** Refresh the views line of the currently displayed episode. */
  function refreshViewsLine() {
    const { series, episode } = currentTarget();
    if (!series || !episode || !viewsEl) return;
    viewsEl.textContent = `${episodeViewsLabel(series.id, episode)} ${t(
      "card.viewsSuffix"
    )}`;
  }

  /** Pull the latest stats from the backend, then update the views line. */
  function fetchPlayStats() {
    return fetch("/api/stats", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        playStats = data && typeof data === "object" ? data : {};
        refreshViewsLine();
        // Re-render sidebar so per-episode counts also update.
        const { series, episode } = currentTarget();
        if (series && episode) renderEpisodeList(series, episode.ep);
      })
      .catch(() => {
        /* offline / no backend — keep static fallback */
      });
  }

  /**
   * Try to load the merged library (built-in + user-imported) so the
   * player works for series that were uploaded via the import dialog.
   */
  function fetchLibrary() {
    return fetch("/api/library", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.imported)) {
          Catalog.mergeImported(data.imported);
        }
      })
      .catch(() => {
        /* offline / no backend — keep built-ins */
      });
  }

  /**
   * Fire-and-forget play-count reporter. The backend stores counts under
   * the composite "<seriesId>:ep<n>" key.
   */
  function reportStat(seriesId, ep, event) {
    if (!seriesId || !ep || !event) return;
    const id = Catalog.episodeKey(seriesId, ep);
    try {
      fetch("/api/stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, event }),
        keepalive: true,
      })
        .then((r) => (r && r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.ok && data.stats) {
            playStats[id] = data.stats;
            refreshViewsLine();
            // Update the corresponding row in the episode list as well.
            const row = upNextList.querySelector(
              `.up-next-item[data-ep="${ep}"] .un-meta`
            );
            const { series } = currentTarget();
            if (row && series) {
              row.textContent = `${t("series.epShort", {
                n: ep,
              })} • ${episodeViewsLabel(series.id, { ep, views: "" })} ${t(
                "card.viewsSuffix"
              )}`;
            }
          }
        })
        .catch(() => {});
    } catch (_) {
      /* fetch unavailable — ignore */
    }
  }

  /* ---------- URL & current target helpers ---------- */

  function getRequestedId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("id");
  }
  function getRequestedEp() {
    const params = new URLSearchParams(window.location.search);
    const n = Number(params.get("ep"));
    return n > 0 ? n : 1;
  }
  /**
   * Optional `t=<seconds>` URL param: when the home-page feed hands
   * off to the player, we carry the preview's current playback time
   * so the viewer picks up right where they left off. Consumed ONCE
   * on the first `loadeddata` event after boot, then cleared from
   * the URL so refresh / history navigation restart cleanly.
   */
  function getRequestedTime() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("t");
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /** Resolve the series + episode currently targeted by the URL/state. */
  function currentTarget() {
    const seriesId = (videoEl && videoEl.dataset.seriesId) || getRequestedId();
    const epNum = Number(videoEl && videoEl.dataset.epNum) || getRequestedEp();
    const series = Catalog.findSeries(seriesId) || (window.VIDEOS || [])[0];
    const episode = Catalog.findEpisode(series, epNum);
    return { series, episode };
  }

  /* ---------- Render ---------- */

  /** Render the main video and its metadata. */
  function loadEpisode(series, episode, opts) {
    opts = opts || {};
    const startAt = Math.max(0, Number(opts.startAt) || 0);

    if (!series || !episode) {
      titleEl.textContent = t("player.notFound.title");
      descEl.textContent = t("player.notFound.desc");
      viewsEl.textContent = "";
      categoryEl.textContent = "";
      if (epCountEl) epCountEl.textContent = "";
      if (tagsEl) tagsEl.innerHTML = "";
      return;
    }

    const localSeriesTitle = i18n.pickLocalized(series, "title");
    const localDesc = i18n.pickLocalized(series, "description");
    const epLabel = t("series.epShort", { n: episode.ep });
    const composedTitle = `${localSeriesTitle} — ${epLabel} ${episode.title || ""}`.trim();

    document.title = `${composedTitle} — BH Video`;

    hidePlaybackError();

    const sameEpisode =
      videoEl.dataset.seriesId === series.id &&
      Number(videoEl.dataset.epNum) === Number(episode.ep);

    if (!sameEpisode) {
      videoEl.src = episode.src;
      videoEl.poster = episode.thumbnail || series.thumbnail;
      videoEl.dataset.seriesId = series.id;
      videoEl.dataset.epNum = String(episode.ep);
      playReportedFor = null;
      videoEl.load();

      // One-shot resume handler: once the browser knows the video's
      // metadata we can safely set currentTime. If we try to seek
      // before `loadedmetadata` the browser throws / silently resets.
      if (startAt > 0) {
        const resumeOnce = () => {
          videoEl.removeEventListener("loadedmetadata", resumeOnce);
          try {
            // Clamp just under duration so we never land past the end.
            const d = Number(videoEl.duration) || 0;
            const safe = d > 0 ? Math.min(startAt, Math.max(0, d - 0.5)) : startAt;
            videoEl.currentTime = safe;
          } catch (_) {
            /* seek may fail on some streams — ignore */
          }
        };
        videoEl.addEventListener("loadedmetadata", resumeOnce);
      }

      // Pre-roll ad gate — only on fresh episode loads. If the ads module
      // decides this is a milestone episode (every N episodes in the same
      // browser), we pause the main video and show the ad overlay first.
      const Ads = window.BHAds;
      const shouldPreRoll =
        Ads && typeof Ads.notifyEpisodeOpen === "function"
          ? Ads.notifyEpisodeOpen(series.id, episode.ep)
          : false;

      const startMainVideo = () => {
        const p = videoEl.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            /* Autoplay may be blocked — user can press play manually. */
          });
        }
      };

      if (shouldPreRoll && Ads && typeof Ads.playPreRoll === "function") {
        // Pause main video until ad finishes/skipped.
        try {
          videoEl.pause();
        } catch (_) {}
        Ads.playPreRoll().finally(() => {
          // Make sure we're still on the same episode (user may have
          // navigated away while the ad was playing).
          if (
            videoEl.dataset.seriesId === series.id &&
            Number(videoEl.dataset.epNum) === Number(episode.ep)
          ) {
            startMainVideo();
          }
        });
      } else {
        startMainVideo();
      }
    }

    titleEl.textContent = composedTitle;
    viewsEl.textContent = `${episodeViewsLabel(series.id, episode)} ${t(
      "card.viewsSuffix"
    )}`;
    if (epCountEl) {
      const total = Array.isArray(series.episodes) ? series.episodes.length : 0;
      epCountEl.textContent = t("series.epCount", { n: total });
    }
    categoryEl.textContent = i18n.localizeCategory(series.category || "");
    descEl.textContent = localDesc;

    // Render the series-level tag chips (full list, no slicing — the
    // player page has more horizontal room than a card).
    if (tagsEl) {
      const tags = Array.isArray(series.tags) ? series.tags : [];
      tagsEl.innerHTML = tags
        .map(
          (tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`
        )
        .join("");
    }
  }

  /** Render the sidebar with all episodes of THIS series. */
  function renderEpisodeList(series, currentEp) {
    if (upNextTitleEl) {
      upNextTitleEl.textContent = t("player.episodes");
    }
    if (!series || !Array.isArray(series.episodes)) {
      upNextList.innerHTML = "";
      return;
    }
    upNextList.innerHTML = series.episodes
      .map((e) => {
        const isActive = Number(e.ep) === Number(currentEp);
        const views = episodeViewsLabel(series.id, e);
        const epShort = t("series.epShort", { n: e.ep });
        const thumb = e.thumbnail || series.thumbnail || "";
        const displayTitle = e.title || epShort;
        return `
        <div class="up-next-item ${isActive ? "active" : ""}"
             data-ep="${escapeAttr(String(e.ep))}"
             role="button" tabindex="0"
             aria-label="${escapeAttr(
               t("card.playEpAria", { ep: e.ep, title: displayTitle })
             )}">
          <div class="thumb">
            <img src="${escapeAttr(thumb)}" alt="${escapeAttr(
          displayTitle
        )}" loading="lazy" />
            <span class="duration">${escapeHtml(e.duration || "")}</span>
            <span class="ep-badge">${escapeHtml(epShort)}</span>
          </div>
          <div>
            <h3 class="un-title">${escapeHtml(displayTitle)}</h3>
            <div class="un-meta">${escapeHtml(epShort)} • ${escapeHtml(
          views
        )} ${escapeHtml(t("card.viewsSuffix"))}</div>
          </div>
        </div>
      `;
      })
      .join("");
  }

  function bindEpisodeEvents() {
    upNextList.addEventListener("click", (e) => {
      const item = e.target.closest(".up-next-item");
      if (!item) return;
      navigateToEp(Number(item.dataset.ep));
    });

    upNextList.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const item = e.target.closest(".up-next-item");
      if (!item) return;
      e.preventDefault();
      navigateToEp(Number(item.dataset.ep));
    });
  }

  /** Switch to another episode in the SAME series within this tab. */
  function navigateToEp(epNum) {
    const seriesId = videoEl.dataset.seriesId || getRequestedId();
    const series = Catalog.findSeries(seriesId);
    const episode = Catalog.findEpisode(series, epNum);
    if (!series || !episode) return;

    const newUrl = `player.html?id=${encodeURIComponent(
      series.id
    )}&ep=${encodeURIComponent(episode.ep)}`;
    window.history.pushState({ id: series.id, ep: episode.ep }, "", newUrl);

    loadEpisode(series, episode);
    renderEpisodeList(series, episode.ep);
    reportStat(series.id, episode.ep, "open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Bind the like / share buttons. */
  function bindActions() {
    likeBtn.addEventListener("click", () => {
      likeBtn.classList.toggle("liked");
      showToast(
        likeBtn.classList.contains("liked")
          ? t("toast.likeAdded")
          : t("toast.likeRemoved")
      );
    });

    shareBtn.addEventListener("click", async () => {
      const shareUrl = window.location.href;
      try {
        if (navigator.share) {
          await navigator.share({ title: document.title, url: shareUrl });
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(shareUrl);
          showToast(t("toast.linkCopied"));
        } else {
          showToast(shareUrl);
        }
      } catch (_) {
        /* User cancelled — ignore */
      }
    });
  }

  /** Auto-play the next episode of the same series when the current ends. */
  function bindAutoPlayNext() {
    videoEl.addEventListener("ended", () => {
      const { series, episode } = currentTarget();
      if (!series || !episode) return;
      reportStat(series.id, episode.ep, "ended");
      const idx = series.episodes.findIndex((e) => e.ep === episode.ep);
      if (idx === -1) return;
      const next = series.episodes[idx + 1];
      if (next) navigateToEp(next.ep);
    });
  }

  /** Report the first real "play" for whichever episode is currently loaded. */
  function bindFirstPlayReporter() {
    videoEl.addEventListener("play", () => {
      const seriesId = videoEl.dataset.seriesId || getRequestedId();
      const ep = Number(videoEl.dataset.epNum) || getRequestedEp();
      if (!seriesId || !ep) return;
      const key = Catalog.episodeKey(seriesId, ep);
      if (playReportedFor === key) return;
      playReportedFor = key;
      reportStat(seriesId, ep, "play");
    });
  }

  /** Handle browser back/forward buttons. */
  function bindHistory() {
    window.addEventListener("popstate", () => {
      const { series, episode } = currentTarget();
      loadEpisode(series, episode);
      if (series && episode) renderEpisodeList(series, episode.ep);
    });
  }

  /* ---------- Toast & error overlay ---------- */
  let toastEl;
  let toastTimer;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  let errorOverlay;
  function showPlaybackError(message) {
    const shell = videoEl.parentElement;
    if (!shell) return;
    if (!errorOverlay) {
      errorOverlay = document.createElement("div");
      errorOverlay.style.cssText =
        "position:absolute;inset:0;display:grid;place-items:center;text-align:center;" +
        "padding:24px;color:#fff;background:rgba(0,0,0,0.78);font-size:14px;" +
        "line-height:1.6;border-radius:inherit;z-index:5;";
      shell.style.position = "relative";
      shell.appendChild(errorOverlay);
    }
    errorOverlay.innerHTML = `
      <div>
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(
          t("error.title")
        )}</div>
        <div style="color:#bbb;max-width:480px;">${escapeHtml(message)}</div>
      </div>`;
    errorOverlay.style.display = "grid";
  }
  function hidePlaybackError() {
    if (errorOverlay) errorOverlay.style.display = "none";
  }

  function bindPlaybackErrors() {
    videoEl.addEventListener("error", () => {
      const err = videoEl.error;
      const msg =
        (err && t("error.code." + err.code)) || t("error.generic");
      showPlaybackError(msg);
    });
    videoEl.addEventListener("stalled", () => {
      // eslint-disable-next-line no-console
      console.warn("[player] network stalled while loading", videoEl.currentSrc);
    });
  }

  /* ---------- Helpers ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /* ---------- Init ---------- */
  function boot() {
    const seriesId = getRequestedId();
    const epNum = getRequestedEp();
    const startAt = getRequestedTime();
    const series = Catalog.findSeries(seriesId) || (window.VIDEOS || [])[0];
    const episode = Catalog.findEpisode(series, epNum);

    bindPlaybackErrors();
    loadEpisode(series, episode, { startAt });

    // Strip `t=` from the URL after we've consumed it so later
    // refreshes / history navigation don't keep rewinding to this
    // same timestamp. The rest of the URL (id, ep) stays intact.
    if (startAt > 0 && window.history && window.history.replaceState) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete("t");
        window.history.replaceState(window.history.state, "", u.toString());
      } catch (_) {}
    }

    if (series && episode) renderEpisodeList(series, episode.ep);
    bindEpisodeEvents();
    bindActions();
    bindAutoPlayNext();
    bindFirstPlayReporter();
    bindHistory();

    fetchPlayStats();

    if (series && episode) reportStat(series.id, episode.ep, "open");

    if (window.I18N && typeof window.I18N.onChange === "function") {
      window.I18N.onChange(() => {
        const { series: s2, episode: e2 } = currentTarget();
        // Preserve the viewer's current position across language
        // changes so switching UI language mid-episode doesn't
        // rewind the video.
        const keepAt = Number(videoEl && videoEl.currentTime) || 0;
        loadEpisode(s2, e2, { startAt: keepAt });
        if (s2 && e2) renderEpisodeList(s2, e2.ep);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Try to load the imported library first so links like
    // player.html?id=imported-series&ep=1 also work after a hard refresh.
    fetchLibrary().then(boot);
  });
})();
