/* =========================================================
   BH Video — Player page (vertical feed, one card per EPISODE)
   -----------------------------------------------------------
   The player page mirrors the home-page immersive feed, but every
   snap card represents ONE EPISODE of a single series (not one
   series). Behaviour:

   - URL: player.html?id=<seriesId>&ep=<n>&t=<seconds>
   - On boot we locate the series, render one `.feed-item` per
     episode, and scroll-snap to the requested one.
   - If `t=` is present, we seek the first-shown episode to that
     time so playback resumes from where the home preview left off
     (then strip `t=` from the URL so refresh starts clean).
   - Swiping up/down activates the next/prev episode's card. Only
     the active card auto-plays; the others are paused to save
     bandwidth.
   - Progress bar is DRAGGABLE — the <video> element in each card
     has the native `controls` attribute enabled.
   - When an episode ends we auto-advance by programmatically
     scrolling to the next card. The last episode just stays on
     its card.
   - A floating "back to home" chip (top-left) exits to index.html.
   - The browser's native back/forward keeps working because every
     episode change pushes a new history entry via replaceState so
     the URL stays shareable without flooding history.

   All strings are routed through window.I18N.
   ========================================================= */

(function () {
  "use strict";

  const Catalog = window.VideoCatalog;
  const feedEl = document.getElementById("feed");
  const emptyEl = document.getElementById("feedEmpty");

  // Hidden legacy element kept so other modules (ads overlays etc.)
  // that look up `#videoPlayer` by id don't throw. Real playback
  // happens inside each feed card.
  const legacyVideoEl = document.getElementById("videoPlayer");

  const i18n = window.I18N || {
    t: (k) => k,
    pickLocalized: (v, f) => (v ? v[f] : ""),
    localizeCategory: (c) => c,
    onChange: () => () => {},
  };
  const t = (k, p) => i18n.t(k, p);

  // Latest play counts from the backend. Shape:
  //   { "<seriesId>:ep<n>": { opens, plays, ends } }
  let playStats = {};

  // Likes state keyed by seriesId: { count, liked }. Hydrated on boot
  // from /api/likes and updated optimistically on every toggle.
  const likesState = new Map();

  // Which episode's "play" we've already reported this session.
  // Guards against double-counting on pause/resume.
  const playReportedFor = new Set();

  /* ---------- URL helpers ---------- */

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
   * Optional `t=<seconds>` URL param carried over from the home
   * feed. Consumed ONCE on the first episode load, then wiped.
   */
  function getRequestedTime() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("t");
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function stripTimeFromUrl() {
    if (!window.history || !window.history.replaceState) return;
    try {
      const u = new URL(window.location.href);
      if (!u.searchParams.has("t")) return;
      u.searchParams.delete("t");
      window.history.replaceState(window.history.state, "", u.toString());
    } catch (_) {}
  }
  /**
   * Keep the URL in sync with whichever episode is currently
   * active. We use `replaceState` instead of `pushState` so
   * swiping through 50 episodes doesn't bloat browser history.
   */
  function syncUrlToEpisode(seriesId, epNum) {
    if (!window.history || !window.history.replaceState) return;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("id", seriesId);
      u.searchParams.set("ep", String(epNum));
      u.searchParams.delete("t");
      window.history.replaceState(
        { id: seriesId, ep: epNum },
        "",
        u.toString()
      );
    } catch (_) {}
  }

  /* ---------- API ---------- */

  function fetchLibrary() {
    // Only fetch what the player page actually needs: the ONE series
    // currently in the URL (?id=...). Falls back to the lightweight
    // catalog if the id lookup fails for any reason (unknown id,
    // backend down, etc.), so legacy deep links still work.
    const id = getRequestedId();
    if (id) {
      return fetch(
        "/api/library/" + encodeURIComponent(id),
        { headers: { Accept: "application/json" } }
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.series) {
            Catalog.mergeImported([data.series]);
            return true;
          }
          return false;
        })
        .catch(() => false)
        .then((hit) => {
          if (hit) return;
          // Fallback: hydrate at least the lightweight catalog so the
          // page can still render SOMETHING (e.g. a "series not found"
          // state driven by the real data).
          return fetch("/api/library/catalog", {
            headers: { Accept: "application/json" },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data && Array.isArray(data.imported)) {
                Catalog.mergeImported(data.imported);
              }
            })
            .catch(() => {});
        });
    }
    // No id in URL — fetch the lightweight catalog as a fallback.
    return fetch("/api/library/catalog", {
      headers: { Accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.imported)) {
          Catalog.mergeImported(data.imported);
        }
      })
      .catch(() => {});
  }

  function fetchPlayStats() {
    return fetch("/api/stats", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        playStats = data && typeof data === "object" ? data : {};
      })
      .catch(() => {
        playStats = {};
      });
  }

  /** Hydrate per-series like counts (and whether the caller liked). */
  function fetchLikes() {
    return fetch("/api/likes", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        likesState.clear();
        if (data && typeof data === "object") {
          Object.keys(data).forEach((sid) => {
            const entry = data[sid] || {};
            likesState.set(sid, {
              count: Number(entry.count) || 0,
              liked: !!entry.liked_by_me,
            });
          });
        }
      })
      .catch(() => {});
  }

  /** Toggle like on the server; optimistically update every card. */
  function toggleLike(seriesId) {
    if (!seriesId) return;
    const prev = likesState.get(seriesId) || { count: 0, liked: false };
    const next = {
      count: prev.liked ? Math.max(0, prev.count - 1) : prev.count + 1,
      liked: !prev.liked,
    };
    likesState.set(seriesId, next);
    paintLikesForSeries(seriesId);

    fetch("/api/likes/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: seriesId }),
      keepalive: true,
    })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.ok) return;
        likesState.set(seriesId, {
          count: Number(data.count) || 0,
          liked: !!data.liked,
        });
        paintLikesForSeries(seriesId);
      })
      .catch(() => {});
  }

  /** Repaint EVERY like button on the page that targets this series. */
  function paintLikesForSeries(seriesId) {
    const state = likesState.get(seriesId) || { count: 0, liked: false };
    const btns = feedEl.querySelectorAll(
      `.feed-item[data-series-id="${cssEscape(seriesId)}"] .feed-like`
    );
    btns.forEach((btn) => {
      btn.classList.toggle("liked", !!state.liked);
      const label = btn.querySelector("[data-like-count]");
      if (label) label.textContent = formatCount(state.count || 0);
    });
  }

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
            // Refresh the side-rail counter on the matching card.
            const card = feedEl.querySelector(
              `.feed-item[data-series-id="${cssEscape(seriesId)}"][data-ep-num="${ep}"]`
            );
            if (card) {
              const label = card.querySelector(".feed-like .feed-side-label");
              if (label) label.textContent = formatCount(data.stats.plays || 0);
            }
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  /* ---------- Formatting ---------- */

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

  function episodePlayCount(seriesId, ep) {
    const key = Catalog.episodeKey(seriesId, ep.ep);
    const stat = playStats && playStats[key];
    if (stat && typeof stat.plays === "number" && stat.plays > 0) {
      return stat.plays;
    }
    return parseViewsLabel(ep.views);
  }

  /* ---------- Build one episode card ---------- */

  /**
   * Build a single feed item for ONE episode of the series.
   * Visually identical to the home-page cards, but:
   *  - the <video> has `controls` (progress bar is draggable)
   *  - the right-side "episode picker" opens a sheet of SAME-series episodes
   *  - tapping the video does NOT navigate away
   */
  function buildEpisodeCard(series, episode, index) {
    const localSeriesTitle = i18n.pickLocalized(series, "title");
    const localDesc = i18n.pickLocalized(series, "description");
    const tags = Array.isArray(series.tags) ? series.tags.slice(0, 3) : [];
    const epCount = (series.episodes || []).length;
    const poster = episode.thumbnail || series.thumbnail || "";
    const plays = formatCount(episodePlayCount(series.id, episode));
    const epShort = t("series.epShort", { n: episode.ep });
    const likeInfo = likesState.get(series.id) || { count: 0, liked: false };

    const item = document.createElement("section");
    item.className = "feed-item feed-item--player";
    item.dataset.seriesId = series.id;
    item.dataset.epNum = String(episode.ep);
    item.dataset.index = String(index);
    item.setAttribute("role", "listitem");

    item.innerHTML = `
      <!-- Native progress bar lives here because of the \`controls\` attr.
           object-fit: contain (set via CSS .feed-item--player) ensures
           the controls stay visible even on vertical devices. -->
      <video class="feed-video"
             controls
             controlsList="nodownload noremoteplayback"
             playsinline webkit-playsinline
             preload="metadata"
             poster="${escapeAttr(poster)}"
             data-series-id="${escapeAttr(series.id)}"
             data-ep-num="${escapeAttr(String(episode.ep))}"></video>

      <div class="feed-gradient"></div>

      <!-- Big center play/pause overlay only shown while paused.
           Clicking it toggles playback — it does NOT navigate. -->
      <button class="feed-playpause" type="button" aria-label="播放/暂停">
        <svg class="icon-play" viewBox="0 0 24 24" width="56" height="56" fill="#fff">
          <path d="M8 5v14l11-7z"></path>
        </svg>
      </button>

      <!-- Right-side action rail (like / share / episode picker) -->
      <div class="feed-side">
        <button class="feed-side-btn feed-like${
          likeInfo.liked ? " liked" : ""
        }" type="button" aria-label="点赞">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
          <span class="feed-side-label" data-like-count>${escapeHtml(
            formatCount(likeInfo.count)
          )}</span>
        </button>

        <button class="feed-side-btn feed-share" type="button" aria-label="分享">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
          <span class="feed-side-label" data-i18n="player.share">分享</span>
        </button>

        <button class="feed-side-btn feed-ep-picker" type="button" aria-label="选集">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2"></rect>
            <line x1="3" y1="10" x2="21" y2="10"></line>
            <line x1="9" y1="4" x2="9" y2="20"></line>
          </svg>
          <span class="feed-side-label feed-ep-count">${escapeHtml(
            t("series.epCount", { n: epCount })
          )}</span>
        </button>
      </div>

      <!-- Bottom info: episode indicator, title, tags, description. -->
      <div class="feed-info">
        <div class="feed-ep-indicator">
          <span class="feed-ep-chip">${escapeHtml(epShort)}</span>
          <span class="feed-ep-sep">·</span>
          <span class="feed-ep-total">${escapeHtml(
            t("series.epCount", { n: epCount })
          )}</span>
        </div>
        <h2 class="feed-title">${escapeHtml(localSeriesTitle)}${
      episode.title ? " — " + escapeHtml(episode.title) : ""
    }</h2>
        ${
          tags.length
            ? `<div class="feed-tags">${tags
                .map((tag) => `<span class="feed-tag">${escapeHtml(tag)}</span>`)
                .join("")}</div>`
            : ""
        }
        <p class="feed-desc">${escapeHtml(localDesc)}</p>
      </div>
    `;
    return item;
  }

  /* ---------- Render the whole feed ---------- */

  function renderFeed(series, initialEp, initialStartAt) {
    if (!series || !Array.isArray(series.episodes) || !series.episodes.length) {
      feedEl.innerHTML = "";
      if (emptyEl) emptyEl.hidden = false;
      return null;
    }
    if (emptyEl) emptyEl.hidden = true;

    document.title = `${i18n.pickLocalized(series, "title")} — BH Video`;

    const frag = document.createDocumentFragment();
    series.episodes.forEach((ep, i) => {
      frag.appendChild(buildEpisodeCard(series, ep, i));
    });
    feedEl.innerHTML = "";
    feedEl.appendChild(frag);

    // Wire up each card.
    feedEl.querySelectorAll(".feed-item").forEach((item) => bindCard(item));

    // Snap to the requested episode BEFORE enabling the observer so
    // the automatic "activate" fires on the right card.
    const target = feedEl.querySelector(
      `.feed-item[data-ep-num="${CSS.escape(String(initialEp))}"]`
    );
    if (target) {
      // `scrollTo` with `instant` bypasses the smooth-scroll CSS so
      // boot doesn't visibly animate from the first episode down.
      try {
        target.scrollIntoView({ block: "start", behavior: "auto" });
      } catch (_) {
        feedEl.scrollTop = target.offsetTop;
      }
      // Remember the one-shot resume time so the observer applies it
      // when it activates this card.
      if (initialStartAt > 0) {
        target.dataset.pendingStart = String(initialStartAt);
      }
    }

    observeFeedItems();

    // Fallback: if IntersectionObserver fires late, kick off the
    // target card manually.
    requestAnimationFrame(() => {
      const first = feedEl.querySelector(".feed-item.is-active");
      if (!first && target) activateCard(target);
    });

    return target;
  }

  /* ---------- Per-card behaviour ---------- */

  function bindCard(item) {
    const seriesId = item.dataset.seriesId;
    const epNum = Number(item.dataset.epNum);
    const series = Catalog.findSeries(seriesId);
    if (!series) return;

    const video = item.querySelector(".feed-video");
    const playBtn = item.querySelector(".feed-playpause");
    const likeBtn = item.querySelector(".feed-like");
    const shareBtn = item.querySelector(".feed-share");
    const epPicker = item.querySelector(".feed-ep-picker");

    // The big center overlay toggles play/pause (doesn't navigate).
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (video.paused) {
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else {
        video.pause();
      }
    });

    // Pause/play icon class toggles.
    video.addEventListener("play", () => {
      item.classList.remove("is-paused");
      const key = Catalog.episodeKey(seriesId, epNum);
      if (!playReportedFor.has(key)) {
        playReportedFor.add(key);
        reportStat(seriesId, epNum, "play");
      }
    });
    video.addEventListener("pause", () => {
      if (!video.ended) item.classList.add("is-paused");
    });

    // Episode ended → auto-advance to the next card.
    video.addEventListener("ended", () => {
      reportStat(seriesId, epNum, "ended");
      const next = item.nextElementSibling;
      if (next && next.classList.contains("feed-item")) {
        next.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // Last episode — show the center play icon as a replay cue.
        item.classList.add("is-paused");
      }
    });

    // Playback errors render a lightweight overlay inside the card.
    video.addEventListener("error", () => {
      const err = video.error;
      const msg =
        (err && t("error.code." + err.code)) || t("error.generic");
      showCardError(item, msg);
    });

    // Like toggle — persist on the backend and sync every like
    // button for this series on the current page.
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(seriesId);
      // Local toast feedback mirrors the state we just optimistically
      // committed to likesState.
      const stateAfter = likesState.get(seriesId);
      showToast(
        stateAfter && stateAfter.liked
          ? t("toast.likeAdded")
          : t("toast.likeRemoved")
      );
    });

    // Share the direct deep-link to this episode.
    shareBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const url =
        location.origin +
        location.pathname +
        "?id=" +
        encodeURIComponent(seriesId) +
        "&ep=" +
        encodeURIComponent(epNum);
      try {
        if (navigator.share) {
          await navigator.share({ title: document.title, url });
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(url);
          showToast(t("toast.linkCopied"));
        } else {
          showToast(url);
        }
      } catch (_) {
        /* user cancelled */
      }
    });

    // Episode picker sheet.
    epPicker.addEventListener("click", (e) => {
      e.stopPropagation();
      openEpisodePicker(series, epNum);
    });
  }

  function showCardError(item, message) {
    let overlay = item.querySelector(".feed-error");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "feed-error";
      item.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="feed-error-inner">
        <div class="feed-error-icon">⚠️</div>
        <div class="feed-error-title">${escapeHtml(t("error.title"))}</div>
        <div class="feed-error-msg">${escapeHtml(message)}</div>
      </div>
    `;
  }

  /* ---------- Visibility orchestration ---------- */

  let feedObserver = null;

  function observeFeedItems() {
    if (feedObserver) {
      try { feedObserver.disconnect(); } catch (_) {}
    }
    feedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            activateCard(entry.target);
          } else {
            deactivateCard(entry.target);
          }
        });
      },
      { root: feedEl, threshold: [0, 0.6, 1] }
    );
    feedEl.querySelectorAll(".feed-item").forEach((item) =>
      feedObserver.observe(item)
    );
  }

  function activateCard(item) {
    if (item.classList.contains("is-active")) return;

    // Deactivate everyone else first.
    feedEl.querySelectorAll(".feed-item.is-active").forEach((other) => {
      if (other !== item) deactivateCard(other);
    });

    item.classList.add("is-active");

    const seriesId = item.dataset.seriesId;
    const epNum = Number(item.dataset.epNum);
    const series = Catalog.findSeries(seriesId);
    const episode = Catalog.findEpisode(series, epNum);
    if (!series || !episode) return;

    const video = item.querySelector(".feed-video");

    // Lazily attach the real source the first time we activate.
    if (!video.src) {
      video.src = episode.src;
      video.load();
    }

    // Keep the shareable URL in sync with the newly active episode.
    syncUrlToEpisode(seriesId, epNum);
    reportStat(seriesId, epNum, "open");

    // One-shot resume from the home-feed hand-off: `?t=<seconds>`.
    const pendingStart = Number(item.dataset.pendingStart) || 0;
    if (pendingStart > 0) {
      delete item.dataset.pendingStart;
      const seekOnce = () => {
        video.removeEventListener("loadedmetadata", seekOnce);
        try {
          const d = Number(video.duration) || 0;
          const safe = d > 0 ? Math.min(pendingStart, Math.max(0, d - 0.5)) : pendingStart;
          video.currentTime = safe;
        } catch (_) {}
      };
      if (video.readyState >= 1) seekOnce();
      else video.addEventListener("loadedmetadata", seekOnce);
    }

    // Pre-roll ad gate — same per-N-episodes rule as the home page.
    const Ads = window.BHAds;
    const shouldPreRoll =
      Ads && typeof Ads.notifyEpisodeOpen === "function"
        ? Ads.notifyEpisodeOpen(seriesId, epNum)
        : false;

    const startPlay = () => {
      if (!item.classList.contains("is-active")) return;
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => item.classList.add("is-paused"));
      }
    };

    if (shouldPreRoll && Ads && typeof Ads.playPreRoll === "function") {
      try { video.pause(); } catch (_) {}
      Ads.playPreRoll().finally(() => {
        if (
          item.classList.contains("is-active") &&
          video.dataset.epNum === String(epNum)
        ) {
          startPlay();
        }
      });
    } else {
      startPlay();
    }
  }

  function deactivateCard(item) {
    item.classList.remove("is-active");
    const video = item.querySelector(".feed-video");
    if (video) {
      try { video.pause(); } catch (_) {}
    }
  }

  /* ---------- Episode picker sheet ---------- */

  let epSheetEl = null;
  function openEpisodePicker(series, currentEp) {
    if (epSheetEl) epSheetEl.remove();
    epSheetEl = document.createElement("div");
    epSheetEl.className = "feed-ep-sheet";
    epSheetEl.innerHTML = `
      <div class="feed-ep-sheet-inner">
        <div class="feed-ep-sheet-head">
          <h3>${escapeHtml(i18n.pickLocalized(series, "title"))}</h3>
          <button class="feed-ep-sheet-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="feed-ep-sheet-grid">
          ${(series.episodes || [])
            .map((e) => {
              const isActive = Number(e.ep) === Number(currentEp);
              return `<button class="feed-ep-cell ${
                isActive ? "active" : ""
              }" data-ep="${escapeAttr(String(e.ep))}">${escapeHtml(
                t("series.epShort", { n: e.ep })
              )}</button>`;
            })
            .join("")}
        </div>
      </div>
    `;
    document.body.appendChild(epSheetEl);
    requestAnimationFrame(() => epSheetEl.classList.add("open"));

    epSheetEl.addEventListener("click", (e) => {
      if (e.target === epSheetEl || e.target.closest(".feed-ep-sheet-close")) {
        closeEpisodePicker();
        return;
      }
      const cell = e.target.closest(".feed-ep-cell");
      if (!cell) return;
      const ep = Number(cell.dataset.ep);
      closeEpisodePicker();
      scrollFeedToEp(ep);
    });
  }
  function closeEpisodePicker() {
    if (!epSheetEl) return;
    const el = epSheetEl;
    epSheetEl = null;
    el.classList.remove("open");
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 260);
  }
  function scrollFeedToEp(epNum) {
    const target = feedEl.querySelector(
      `.feed-item[data-ep-num="${CSS.escape(String(epNum))}"]`
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Toast ---------- */
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

  /* ---------- Helpers ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  /* ---------- Init ---------- */

  function boot() {
    const seriesId = getRequestedId();
    const epNum = getRequestedEp();
    const startAt = getRequestedTime();
    const series =
      Catalog.findSeries(seriesId) || (window.VIDEOS || [])[0] || null;

    renderFeed(series, epNum, startAt);

    // Consume `?t=` so refreshes start clean (we've already stashed
    // the value in the card's dataset for activateCard to apply).
    stripTimeFromUrl();

    // Pause everything when tab goes to background; resume active card
    // when it comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        feedEl.querySelectorAll(".feed-video").forEach((v) => {
          try { v.pause(); } catch (_) {}
        });
      } else {
        const active = feedEl.querySelector(".feed-item.is-active .feed-video");
        if (active) {
          const p = active.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      }
    });

    // Browser back/forward keeps the URL state in sync — but since we
    // use replaceState for every episode change we just need to react
    // to the user hitting back from outside the feed.
    window.addEventListener("popstate", () => {
      const ep = getRequestedEp();
      scrollFeedToEp(ep);
    });

    // Language switch → re-render whole feed, keeping current episode
    // and current playback time.
    if (window.I18N && typeof window.I18N.onChange === "function") {
      window.I18N.onChange(() => {
        const active = feedEl.querySelector(".feed-item.is-active");
        const curEp = active ? Number(active.dataset.epNum) : epNum;
        const vid = active && active.querySelector(".feed-video");
        const keepAt = vid ? Number(vid.currentTime) || 0 : 0;
        renderFeed(series, curEp, keepAt);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Fetch library first so imported-but-not-built-in series work on
    // hard refresh, then fetch stats + likes (best effort), then boot.
    Promise.all([fetchLibrary(), fetchPlayStats(), fetchLikes()]).then(boot);
  });
})();
